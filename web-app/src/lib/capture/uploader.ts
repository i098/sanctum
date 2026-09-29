/**
 * Uploads buffered WAV chunks through `ListenersApi.putChunk` (plan 05, T09 browser half).
 * Local audio is deleted only after a receipt matching the manifest is journaled; a retry
 * resends the same chunk ID and bytes, so the server can return the original receipt or
 * finish a manifest whose R2 write already succeeded. A chunk of an epoch the server does not
 * know waits for, or first gets, that epoch's registration. Chunks the server still refuses (other
 * bytes under the same ID, or an epoch or listener it will not register) are kept but skipped;
 * authorization failures keep the audio and stop instead of retrying blindly.
 */
import type { ListenerId, RecordingChunkManifest, RecordingChunkReceipt } from '@sanctum/contracts';
import { Data, Duration, Effect, Schedule } from 'effect';
import type { SealedChunk } from './recorder.ts';
import type { ListenersClient } from './client.ts';

export interface PendingStore {
  nextPending(listenerId: string): Promise<SealedChunk | null>;
  markRefused(chunkId: string): Promise<void>;
  acknowledge(manifest: RecordingChunkManifest, receipt: RecordingChunkReceipt): Promise<void>;
}

export interface UploadEvents {
  onUploading(manifest: RecordingChunkManifest): void;
  onSaved(manifest: RecordingChunkManifest, receipt: RecordingChunkReceipt): void;
  /** The server refused the chunk; the local copy is kept, never offered for upload again. */
  onRefused(manifest: RecordingChunkManifest): void;
  /**
   * The server does not know the chunk's epoch: `wait` while its start may still reach the server
   * (drain again later), `registered` once it recorded the epoch, `refused` when it never will.
   */
  unknownEpoch(epochId: string): Effect.Effect<'wait' | 'registered' | 'refused'>;
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
class UnknownEpoch extends Data.TaggedError('UnknownEpoch') {}

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
        NotFound: () => new UnknownEpoch(),
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
    const registered = new Set<string>();
    for (; ;) {
      const chunk = yield* storage(() => store.nextPending(listenerId));
      if (chunk === null) return;
      events.onUploading(chunk.manifest);
      const outcome = yield* putChunk(client, chunk, timeout).pipe(
        Effect.retry({ schedule: retry, while: (error) => error._tag === 'Retryable' }),
        Effect.catchTags({ Conflict: () => Effect.succeed('conflict' as const), UnknownEpoch: () => Effect.succeed('unknown_epoch' as const) }),
      );
      const { epoch_id } = chunk.manifest;
      if (outcome === 'unknown_epoch' && !registered.has(epoch_id)) {
        const next = yield* events.unknownEpoch(epoch_id).pipe(Effect.timeoutTo({ duration: timeout, onSuccess: (next) => next, onTimeout: () => 'wait' as const }));
        if (next === 'wait') return;
        if (next === 'registered') {
          registered.add(epoch_id);
          continue; // the same chunk is next again
        }
      }
      if (typeof outcome === 'string') {
        yield* storage(() => store.markRefused(chunk.manifest.chunk_id));
        events.onRefused(chunk.manifest);
        continue;
      }
      yield* storage(() => store.acknowledge(chunk.manifest, outcome));
      events.onSaved(chunk.manifest, outcome);
    }
  }).pipe(
    Effect.catchTags({
      Stop: (stop) => Effect.fail(stop.reason),
      Retryable: () => Effect.fail('unavailable' as const),
    }),
  );
}
