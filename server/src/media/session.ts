/**
 * One accepted live-ingest session (plan section 04 "Live media and speech ownership", T10).
 * Frames are validated against the accepted `start` and advance the live watermark; a bounded live-ASR
 * lane forwards contiguous audio to the provider. Each provider connection persists its epoch anchor,
 * so returned times map back to source samples; a gap, overload or failure rotates to a new connection
 * and the skipped range is left to batch reconciliation instead of being labelled transcribed.
 * A socket is only a transport attempt: reconnecting with the same epoch resumes at the watermark.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import {
  type AccessScope,
  decodePcmFrame,
  type ListenerId,
  type PcmFrame,
  ProviderConnectionId,
  RejectedMessage,
  type ServerControlMessage,
  type SourceRange,
  type StartMessage,
  TranscriptSegment,
} from '@sanctum/contracts';
import { Data, Deferred, Effect, Either, Exit, Fiber, Option, Schedule, Schema, Scope, Stream } from 'effect';
import { advanceLiveWatermark, stopEpoch } from '../listeners.ts';
import { type AsrResult, type AsrStream, SpeechToText } from '../providers/deepgram.ts';
import { publishFinalWindow } from '../transcripts.ts';
import { SpeechGate } from './speech-gate.ts';

export const liveLimits = {
  /** Provider send backlog at which live ASR is skipped and the range left to batch reconciliation. */
  asrBacklogBytes: 512 * 1024,
  /** Wait before reopening a failed or overloaded provider connection. */
  providerRetryMs: 5_000,
  /** Watermark persistence and ownership-fencing interval. */
  watermarkFlushMs: 1_000,
  /** Time the provider gets to flush final results when a connection closes. */
  finishTimeoutMs: 5_000,
};

/** Ends the session with a `rejected` message to the client. */
export class SessionRejected extends Data.TaggedError('SessionRejected')<{ readonly message: typeof RejectedMessage.Type }> {}

export const reject = (reason: (typeof RejectedMessage.Type)['reason'], message: string) =>
  Effect.fail(new SessionRejected({ message: RejectedMessage.make({ reason, message }) }));

interface Lane {
  readonly connection_id: ProviderConnectionId;
  readonly anchor: number;
  next_sample: number;
  readonly stream: AsrStream;
  readonly scope: Scope.CloseableScope;
  consumer: Fiber.RuntimeFiber<void> | null;
}

export interface LiveSessionInput {
  readonly access: AccessScope;
  readonly listener: { readonly id: ListenerId; readonly capture_group_id: string | null };
  readonly start: typeof StartMessage.Type;
  readonly resume_from_sample: number;
  readonly send: (message: ServerControlMessage) => Effect.Effect<void>;
}

const makePartial = Schema.decodeSync(TranscriptSegment);

/** Display-only interim text; never persisted and never a committed fact. */
const partialSegment = (stt: { readonly provider: string; readonly model: string }, connection_id: ProviderConnectionId, source: SourceRange, result: AsrResult) =>
  makePartial({
    id: randomUUID(),
    source,
    text: result.text,
    status: 'partial',
    revision: 1,
    origin: 'live',
    provider: stt.provider,
    model: stt.model,
    provider_connection_id: connection_id,
    speaker_label: result.speaker,
    speaker_track_id: null,
    confidence: result.confidence,
    created_at: new Date().toISOString(),
  });

/** Maps one provider result to epoch samples: partials go to the client only, finals become evidence first. */
const relayResult = (
  { access, listener, start, send }: Omit<LiveSessionInput, 'resume_from_sample'>,
  stt: { readonly provider: string; readonly model: string },
  current: Lane,
  result: AsrResult,
) =>
  Effect.gen(function* () {
    const rate = start.clock.sample_rate;
    const sample_start = current.anchor + Math.round(result.start_s * rate);
    const sample_end = Math.min(current.anchor + Math.round(result.end_s * rate), current.next_sample);
    if (sample_end <= sample_start) return;
    const source = { epoch_id: start.epoch_id, track: start.track, sample_start, sample_end };
    if (!result.is_final) return yield* send({ _tag: 'transcript', segment: partialSegment(stt, current.connection_id, source, result) });
    const segments = yield* publishFinalWindow({
      workspace_id: access.workspace_id,
      epoch_id: start.epoch_id,
      track: start.track,
      window: { sample_start, sample_end },
      segments: [{ sample_start, sample_end, text: result.text, confidence: result.confidence, speaker_label: result.speaker }],
      origin: 'live',
      provider: stt.provider,
      model: stt.model,
      provider_connection_id: current.connection_id,
      listener_id: listener.id,
      capture_group_id: listener.capture_group_id,
    });
    for (const segment of segments) yield* send({ _tag: 'transcript', segment });
  }).pipe(Effect.catchAll(error => Effect.logWarning('Live final not persisted; batch reconciliation covers the range', error)));

/**
 * The live-ASR lane of one session: at most one provider connection, anchored at the sample it
 * started from. Gaps, overload and failures detach it and report the range as degraded.
 */
const liveAsr = ({ access, listener, start, send }: Omit<LiveSessionInput, 'resume_from_sample'>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const stt = yield* SpeechToText;
    const { workspace_id } = access;
    const { epoch_id, track } = start;
    const rate = start.clock.sample_rate;
    let lane: Lane | null = null;
    let retryAt = 0;
    let providerDown = false;

    const closeLane = (current: Lane, reason: string) =>
      Effect.gen(function* () {
        yield* current.stream.finish;
        if (current.consumer !== null) yield* Fiber.await(current.consumer).pipe(Effect.timeout(liveLimits.finishTimeoutMs), Effect.ignore);
        yield* Scope.close(current.scope, Exit.void);
        yield* sql`
          UPDATE provider_connections SET closed_at = UTC_TIMESTAMP(6), close_reason = ${reason}
          WHERE workspace_id = ${workspace_id} AND id = ${current.connection_id}`.pipe(Effect.catchAll(error => Effect.logWarning('Provider connection close not recorded', error)));
      });

    /** Detaches the lane now and lets it flush in the background, bounded by `finishTimeoutMs`. */
    const rotate = (reason: string) =>
      Effect.gen(function* () {
        if (lane === null) return;
        const current = lane;
        lane = null;
        yield* Effect.forkDaemon(closeLane(current, reason));
      });

    const providerUnavailable = (from_sample: number, message: string) =>
      Effect.gen(function* () {
        retryAt = Date.now() + liveLimits.providerRetryMs;
        yield* Effect.logWarning('Live ASR unavailable', message);
        if (providerDown) return;
        providerDown = true;
        yield* send({ _tag: 'degraded', reason: 'provider_unavailable', from_sample });
      });

    const open = (anchor: number) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const opened = yield* stt.openStream(rate).pipe(Scope.extend(scope), Effect.either);
        if (Either.isLeft(opened)) {
          yield* Scope.close(scope, Exit.void);
          return yield* providerUnavailable(anchor, opened.left.message);
        }
        providerDown = false;
        const connection_id = ProviderConnectionId.make(randomUUID());
        yield* sql`
          INSERT INTO provider_connections (id, workspace_id, epoch_id, track, purpose, provider, model, anchor_sample, sample_rate, opened_at)
          VALUES (${connection_id}, ${workspace_id}, ${epoch_id}, ${track}, 'asr', ${stt.provider}, ${stt.model}, ${anchor}, ${rate}, UTC_TIMESTAMP(6))`;
        const current: Lane = { connection_id, anchor, next_sample: anchor, stream: opened.right, scope, consumer: null };
        current.consumer = yield* opened.right.results.pipe(
          Stream.runForEach(result => relayResult({ access, listener, start, send }, stt, current, result)),
          Effect.catchAll(error =>
            Effect.gen(function* () {
              if (lane === current) lane = null;
              yield* providerUnavailable(current.next_sample, error.message);
            }),
          ),
          Effect.forkIn(scope),
        );
        lane = current;
      });

    const feed = (frame: PcmFrame) =>
      Effect.gen(function* () {
        if (lane !== null && frame.sample_start !== lane.next_sample) yield* rotate('source_gap');
        if (lane !== null && lane.stream.backlogBytes() + frame.samples.byteLength > liveLimits.asrBacklogBytes) {
          yield* rotate('provider_backlog');
          retryAt = Date.now() + liveLimits.providerRetryMs;
          yield* send({ _tag: 'degraded', reason: 'asr_backlog', from_sample: frame.sample_start });
        }
        if (lane === null && Date.now() >= retryAt) yield* open(frame.sample_start);
        if (lane === null) return;
        if (lane.stream.send(frame.samples)) lane.next_sample = frame.sample_start + frame.sample_count;
        else yield* rotate('provider_closed');
      });

    /** Flushes and closes the current connection, waiting for its final results. */
    const close = (reason: string) =>
      Effect.gen(function* () {
        if (lane === null) return;
        const current = lane;
        lane = null;
        yield* closeLane(current, reason);
      });

    return { feed, close };
  });

/** Opens the session in the current scope; closing that scope persists the watermark and flushes provider finals. */
export const openLiveSession = ({ access, listener, start, resume_from_sample, send }: LiveSessionInput) =>
  Effect.gen(function* () {
    const gate = yield* Effect.serviceOption(SpeechGate);
    const { epoch_id, track } = start;
    let watermark = resume_from_sample;
    let persisted = watermark;
    const fenced = yield* Deferred.make<never, SessionRejected>();
    const asr = yield* liveAsr({ access, listener, start, send });

    const flush = Effect.gen(function* () {
      if (watermark === persisted) return;
      const target = watermark;
      const owner = yield* advanceLiveWatermark(access, listener.id, epoch_id, start.lease_generation, target);
      if (!owner) {
        const message = RejectedMessage.make({ reason: 'stale_generation', message: 'Another tab or device took over this listener' });
        return yield* Deferred.fail(fenced, new SessionRejected({ message }));
      }
      persisted = target;
    }).pipe(Effect.catchAll(error => Effect.logWarning('Live watermark not persisted', error)));

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* flush;
        yield* asr.close('session_end');
        if (Option.isSome(gate)) gate.value.cancel(listener.id, 'live session ended');
      }),
    );
    yield* Effect.forkScoped(Effect.repeat(flush, Schedule.spaced(liveLimits.watermarkFlushMs)));

    /** Validates one binary frame, advances the watermark, feeds live ASR and acknowledges live acceptance. */
    const frame = (bytes: Uint8Array) =>
      Effect.gen(function* () {
        const decoded = decodePcmFrame(bytes);
        if ('error' in decoded) return yield* reject('protocol_error', `Malformed frame: ${decoded.error}`);
        const { frame } = decoded;
        if (frame.track !== track) return yield* reject('protocol_error', 'Frame track differs from the accepted start');
        const end = frame.sample_start + frame.sample_count;
        if (end <= watermark) return yield* send({ _tag: 'ack', sequence: frame.sequence, sample_end: watermark });
        if (frame.sample_start < watermark) return yield* reject('protocol_error', 'Frame overlaps audio already accepted');
        watermark = end;
        yield* asr.feed(frame);
        yield* send({ _tag: 'ack', sequence: frame.sequence, sample_end: end });
      });

    /** Client `stop`: persist the watermark, flush finals, then end the epoch. */
    const stop = (reason: 'pause' | 'close' | 'device_change') =>
      Effect.gen(function* () {
        yield* flush;
        yield* asr.close('stopped');
        yield* stopEpoch(access, listener.id, epoch_id, start.lease_generation, reason);
      });

    return { frame, stop, fenced: Deferred.await(fenced) };
  });
