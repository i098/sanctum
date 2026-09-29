/**
 * `transcript.reconcile` job (plan section 05 "Offline and transcript reconciliation", T11): batch-
 * transcribes the parts of an uploaded source range that still lack final ASR coverage, reading the
 * archived WAV chunks. Batch results only become transcript evidence: no audio is played and no speech
 * request or action is opened. Reruns after a crash, provider retry or duplicate delivery skip what
 * coverage already records; ranges without an archived chunk stay reported gaps, never invented text.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient, SqlSchema } from '@effect/sql';
import { CaptureEpochId, EpochEndReason, JobFailure, ListenerId, ProviderConnectionId, SampleIndex, type WorkspaceId } from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { ObjectStore } from '../providers/object-store.ts';
import { SpeechToText } from '../providers/deepgram.ts';
import { DbSafeInt } from '../db.ts';
import { onCaptureEnded } from '../meetings.ts';
import { listCommittedChunks } from '../recordings.ts';
import { coverageIn, publishFinalWindow, type SampleSpan, uncovered } from '../transcripts.ts';

const ReconcilePayload = Schema.Struct({
  epoch_id: CaptureEpochId,
  track: Schema.Number.pipe(Schema.int(), Schema.between(0, 65_535)),
  sample_start: SampleIndex,
  sample_end: SampleIndex,
});

const EpochListener = Schema.Struct({ id: ListenerId, capture_group_id: Schema.NullOr(Schema.String) });

const WAV_HEADER_BYTES = 44;

const ArchiveEnd = Schema.Struct({
  listener_id: ListenerId,
  end_reason: Schema.NullOr(EpochEndReason),
  archive: DbSafeInt,
  idle: DbSafeInt,
  sample_end: Schema.NullOr(DbSafeInt),
});

/**
 * An archive-only epoch (recovered offline audio, never live) that ended by close or interruption
 * seals its meeting once its uploaded audio is reconciled, so notes and memory run without waiting
 * for a later boundary. Skipped while the listener captures live: that session owns the open meeting.
 */
const sealArchiveEpoch = (workspace_id: WorkspaceId, epoch_id: CaptureEpochId, track: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [end] = yield* SqlSchema.findAll({
      Request: CaptureEpochId,
      Result: ArchiveEnd,
      execute: id => sql`
        SELECT e.listener_id, e.end_reason, e.ended_at IS NOT NULL AND e.live_sample_end = e.sample_start AS archive,
               l.current_epoch_id IS NULL OR l.current_epoch_id = e.id AS idle,
               (SELECT MAX(c.sample_start + c.sample_count) FROM recording_chunks c
                WHERE c.workspace_id = e.workspace_id AND c.epoch_id = e.id AND c.track = ${track} AND c.upload_state = 'committed') AS sample_end
        FROM capture_epochs e JOIN listeners l ON l.workspace_id = e.workspace_id AND l.id = e.listener_id
        WHERE e.workspace_id = ${workspace_id} AND e.id = ${id}`,
    })(epoch_id).pipe(Effect.catchTag('ParseError', Effect.die));
    if (end === undefined || end.archive !== 1 || end.idle !== 1 || end.sample_end === null || end.end_reason === null) return;
    yield* onCaptureEnded({ workspace_id, listener_id: end.listener_id, epoch_id, track, sample_end: end.sample_end, reason: end.end_reason });
  });

export const reconcileTranscript = (job: { readonly workspace_id: WorkspaceId; readonly payload: unknown }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ObjectStore;
    const stt = yield* SpeechToText;
    const { workspace_id } = job;
    const { epoch_id, track, ...range } = yield* Schema.decodeUnknown(ReconcilePayload)(job.payload).pipe(
      Effect.mapError(() => new JobFailure({ message: 'Invalid transcript.reconcile payload', retryable: false })),
    );
    const listener = yield* SqlSchema.single({
      Request: CaptureEpochId,
      Result: EpochListener,
      execute: id => sql`
        SELECT l.id, l.capture_group_id FROM capture_epochs e JOIN listeners l ON l.workspace_id = e.workspace_id AND l.id = e.listener_id
        WHERE e.workspace_id = ${workspace_id} AND e.id = ${id}`,
    })(epoch_id).pipe(Effect.catchTags({ ParseError: Effect.die, NoSuchElementException: () => new JobFailure({ message: 'Capture epoch not found', retryable: false }) }));

    const chunks = yield* listCommittedChunks({ workspace_id, source: { epoch_id, track, ...range } });
    const transcribed: Array<SampleSpan> = [];
    for (const chunk of chunks) {
      const span = { sample_start: Math.max(range.sample_start, chunk.sample_start), sample_end: Math.min(range.sample_end, chunk.sample_start + chunk.sample_count) };
      const gaps = uncovered(span, yield* coverageIn(workspace_id, epoch_id, track, span));
      if (gaps.length === 0) continue;
      const wav = yield* store.get(chunk.object_key).pipe(Effect.mapError(error => new JobFailure({ message: `Archive read failed: ${error.message}`, retryable: true })));
      const pcm = new Int16Array(wav.slice(WAV_HEADER_BYTES).buffer);
      for (const gap of gaps) {
        const samples = pcm.subarray(gap.sample_start - chunk.sample_start, gap.sample_end - chunk.sample_start);
        const results = yield* stt.transcribe(chunk.sample_rate, samples).pipe(Effect.mapError(error => new JobFailure({ message: error.message, retryable: error.retryable })));
        const provider_connection_id = ProviderConnectionId.make(randomUUID());
        yield* sql`
          INSERT INTO provider_connections (id, workspace_id, epoch_id, track, purpose, provider, model, anchor_sample, sample_rate, opened_at, closed_at, close_reason)
          VALUES (${provider_connection_id}, ${workspace_id}, ${epoch_id}, ${track}, 'batch_asr', ${stt.provider}, ${stt.model}, ${gap.sample_start},
                  ${chunk.sample_rate}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), 'batch_complete')`;
        const toSample = (seconds: number) => Math.min(gap.sample_start + Math.round(seconds * chunk.sample_rate), gap.sample_end);
        yield* publishFinalWindow({
          workspace_id,
          epoch_id,
          track,
          window: gap,
          segments: results.map(result => ({
            sample_start: toSample(result.start_s),
            sample_end: toSample(result.end_s),
            text: result.text,
            confidence: result.confidence,
            speaker_label: result.speaker,
          })),
          origin: 'batch',
          provider: stt.provider,
          model: stt.model,
          provider_connection_id,
          listener_id: listener.id,
          capture_group_id: listener.capture_group_id,
        });
        transcribed.push(gap);
      }
    }
    const missing_audio = uncovered(range, chunks.map(chunk => ({ sample_start: chunk.sample_start, sample_end: chunk.sample_start + chunk.sample_count })));
    yield* sealArchiveEpoch(workspace_id, epoch_id, track);
    return { status: 'succeeded' as const, result: { transcribed, missing_audio } };
  }).pipe(Effect.catchTag('SqlError', error => new JobFailure({ message: `Database error: ${error.message}`, retryable: true })));
