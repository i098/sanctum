/**
 * Uploads buffered WAV chunks through `ListenersApi.putChunk` (plan 05, T09 browser half).
 * Local audio is deleted only after a receipt matching the manifest is journaled; a retry
 * resends the same chunk ID and bytes, so the server can return the original receipt or
 * finish a manifest whose R2 write already succeeded. Conflicts and authorization failures
 * keep the audio and stop instead of retrying blindly.
 */
import type { ListenerId, RecordingChunkManifest, RecordingChunkReceipt } from '@sanctum/contracts';
import { Data, Duration, Effect, Schedule } from 'effect';
import type { SealedChunk } from './recorder.ts';
import type { ListenersClient } from './client.ts';

export interface PendingStore {
  nextPending(listenerId: string): Promise<SealedChunk | null>;
  markConflict(chunkId: string): Promise<void>;
  acknowledge(manifest: RecordingChunkManifest, receipt: RecordingChunkReceipt): Promise<void>;
}

export interface UploadEvents {
  onUploading(manifest: RecordingChunkManifest): void;
  onSaved(manifest: RecordingChunkManifest, receipt: RecordingChunkReceipt): void;
  /** Same chunk ID already stored with different bytes; the local copy is kept for review. */
  onConflict(manifest: RecordingChunkManifest): void;
}

export interface UploaderOptions {
  readonly timeout?: Duration.DurationInput;
  readonly retry?: Schedule.Schedule<unknown, unknown>;
}

/** Why a drain stopped with audio still buffered. */
export type DrainStop = 'unauthorized' | 'unavailable' | 'storage';

class Retryable extends Data.TaggedError('Retryable')<{ readonly cause: unknown }> { }
class Stop extends Data.TaggedError('Stop')<{ readonly reason: DrainStop }> { }
class Conflict extends Data.TaggedError('Conflict') {}

const defaultRetry = Schedule.exponential('1 second').pipe(Schedule.jittered, Schedule.union(Schedule.spaced('60 seconds')));

const receiptMatches = (manifest: RecordingChunkManifest, receipt: RecordingChunkReceipt) =>
  receipt.chunk_id === manifest.chunk_id && receipt.sha256 === manifest.sha256 && receipt.byte_length === manifest.byte_length;

function putChunk(client: ListenersClient, { manifest, wav }: SealedChunk, timeout: Duration.DurationInput) {
  return client
    .putChunk({ path: { listener_id: manifest.listener_id, chunk_id: manifest.chunk_id }, headers: { 'x-sanctum-manifest': manifest }, payload: wav })
    .pipe(
      Effect.timeout(timeout),
      Effect.catchTags({
        HashConflict: () => new Conflict(),
        Unauthenticated: () => new Stop({ reason: 'unauthorized' }),
        Forbidden: () => new Stop({ reason: 'unauthorized' }),
        NotFound: () => new Stop({ reason: 'unauthorized' }),
        Unavailable: (error) => (error.retryable ? new Retryable({ cause: error }) : new Stop({ reason: 'unavailable' })),
        TimeoutException: (cause) => new Retryable({ cause }),
        RequestError: (cause) => new Retryable({ cause }),
        ResponseError: (cause) => new Retryable({ cause }),
        HttpApiDecodeError: (cause) => new Retryable({ cause }),
        ParseError: (cause) => new Retryable({ cause }),
      }),
      Effect.filterOrFail(
        (receipt) => receiptMatches(manifest, receipt),
        (receipt) => new Retryable({ cause: receipt }),
      ),
    );
}

const storage = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: () => new Stop({ reason: 'storage' }) });

/**
 * Uploads every pending chunk of `listenerId`, oldest first, retrying transient failures with
 * backoff. Succeeds when nothing uploadable is left, or fails with the reason it stopped.
 */
export function drainPending(
  store: PendingStore,
  client: ListenersClient,
  listenerId: ListenerId,
  events: UploadEvents,
  options: UploaderOptions = {},
): Effect.Effect<void, DrainStop> {
  const { timeout = '60 seconds', retry = defaultRetry } = options;
  return Effect.gen(function* () {
    for (; ;) {
      const chunk = yield* storage(() => store.nextPending(listenerId));
      if (chunk === null) return;
      events.onUploading(chunk.manifest);
      const receipt = yield* putChunk(client, chunk, timeout).pipe(
        Effect.retry({ schedule: retry, while: (error) => error._tag === 'Retryable' }),
        Effect.catchTag('Conflict', () => Effect.succeed(null)),
      );
      if (receipt === null) {
        yield* storage(() => store.markConflict(chunk.manifest.chunk_id));
        events.onConflict(chunk.manifest);
        continue;
      }
      yield* storage(() => store.acknowledge(chunk.manifest, receipt));
      events.onSaved(chunk.manifest, receipt);
    }
  }).pipe(
    Effect.catchTags({
      Stop: (stop) => Effect.fail(stop.reason),
      Retryable: () => Effect.fail('unavailable' as const),
    }),
  );
}
