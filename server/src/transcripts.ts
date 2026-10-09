/**
 * Final transcript evidence and its coverage (plan section 05 "Live path" and "Offline and transcript
 * reconciliation", T10/T11). Segments are immutable: replays of the same text are no-ops, changed text
 * for a range becomes a higher revision, and `transcript_coverage` records which audio a provider has
 * finished (including silence), so reconciliation only batch-transcribes what is still missing.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient, SqlSchema } from '@effect/sql';
import {
  type AccessScope,
  CaptureEpochId,
  ListenerId,
  type MeetingId,
  ProviderConnectionId,
  type SourceRange,
  TranscriptSegment,
  type TranscriptSegmentId,
  type WorkspaceId,
} from '@sanctum/contracts';
import { Effect, Option, Schema } from 'effect';
import { DbSafeInt, DbUtc } from './db.ts';
import { OPEN_STATES, scheduleFinalize } from './meeting-store.ts';
import { onFinalSegments } from './meetings.ts';
import { workspaceIsLive } from './store.ts';

export interface SampleSpan {
  readonly sample_start: number;
  readonly sample_end: number;
}

export interface FinalWindow {
  readonly workspace_id: WorkspaceId;
  readonly epoch_id: CaptureEpochId;
  readonly track: number;
  /** Audio the provider finished, including silence that produced no words. */
  readonly window: SampleSpan;
  readonly segments: ReadonlyArray<SampleSpan & { readonly text: string; readonly confidence: number | null; readonly speaker_label: string | null }>;
  readonly origin: 'live' | 'batch';
  readonly provider: string;
  readonly model: string;
  readonly provider_connection_id: ProviderConnectionId | null;
}

const SegmentRow = Schema.Struct({
  id: Schema.String,
  epoch_id: CaptureEpochId,
  track: DbSafeInt,
  sample_start: DbSafeInt,
  sample_end: DbSafeInt,
  text: Schema.String,
  status: Schema.Literal('partial', 'final'),
  revision: DbSafeInt,
  origin: Schema.Literal('live', 'batch', 'correction'),
  provider: Schema.String,
  model: Schema.String,
  provider_connection_id: Schema.NullOr(Schema.String),
  speaker_label: Schema.NullOr(Schema.String),
  speaker_track_id: Schema.NullOr(Schema.String),
  confidence: Schema.NullOr(Schema.Number),
  created_at: DbUtc,
});

const toSegment = Schema.decodeSync(TranscriptSegment);

const segmentsWhere = (condition: (sql: SqlClient.SqlClient) => ReturnType<SqlClient.SqlClient['and']>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findAll({
      Request: Schema.Void,
      Result: SegmentRow,
      execute: () => sql`
        SELECT id, epoch_id, track, sample_start, sample_end, text, status, revision, origin, provider, model, provider_connection_id,
               speaker_label, speaker_track_id, confidence, created_at
        FROM transcript_segments s WHERE ${condition(sql)} ORDER BY sample_start, sample_end, revision`,
    });
    const rows = yield* find(undefined).pipe(Effect.catchTag('ParseError', Effect.die));
    return rows.map(({ epoch_id, track, sample_start, sample_end, ...row }) => toSegment({ ...row, source: { epoch_id, track, sample_start, sample_end } }));
  });

/** Latest revision of each final segment overlapping `source`, in source order. */
export const finalSegments = (access: AccessScope, source: SourceRange) =>
  segmentsWhere(sql =>
    sql.and([
      sql`workspace_id = ${access.workspace_id} AND epoch_id = ${source.epoch_id} AND track = ${source.track} AND status = 'final'`,
      sql`sample_start < ${source.sample_end} AND sample_end > ${source.sample_start}`,
      sql`revision = (SELECT MAX(t.revision) FROM transcript_segments t WHERE t.epoch_id = s.epoch_id AND t.track = s.track
                      AND t.sample_start = s.sample_start AND t.sample_end = s.sample_end)`,
    ]),
  );

/** Exact segment revisions by ID, for source validation; IDs outside the workspace are omitted. */
export const getSegments = (access: AccessScope, ids: ReadonlyArray<TranscriptSegmentId>) =>
  ids.length === 0 ? Effect.succeed([]) : segmentsWhere(sql => sql`workspace_id = ${access.workspace_id} AND ${sql.in('id', ids)}`);

const CoverageRow = Schema.Struct({ sample_start: DbSafeInt, sample_end: DbSafeInt, origin: Schema.Literal('live', 'batch') });

/** Coverage rows overlapping `span`, in source order. */
export const coverageIn = (workspace_id: WorkspaceId, epoch_id: CaptureEpochId, track: number, span: SampleSpan) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findAll({
      Request: Schema.Void,
      Result: CoverageRow,
      execute: () => sql`
        SELECT sample_start, sample_end, origin FROM transcript_coverage
        WHERE workspace_id = ${workspace_id} AND epoch_id = ${epoch_id} AND track = ${track}
          AND sample_start < ${span.sample_end} AND sample_end > ${span.sample_start}
        ORDER BY sample_start`,
    });
    return yield* find(undefined).pipe(Effect.catchTag('ParseError', Effect.die));
  });

/** Parts of `span` no coverage row reaches, in order; `covered` must be sorted by `sample_start`. */
export function uncovered(span: SampleSpan, covered: ReadonlyArray<SampleSpan>): Array<SampleSpan> {
  const gaps: Array<SampleSpan> = [];
  let cursor = span.sample_start;
  for (const range of covered) {
    if (range.sample_start > cursor) gaps.push({ sample_start: cursor, sample_end: Math.min(range.sample_start, span.sample_end) });
    cursor = Math.max(cursor, range.sample_end);
    if (cursor >= span.sample_end) return gaps;
  }
  if (cursor < span.sample_end) gaps.push({ sample_start: cursor, sample_end: span.sample_end });
  return gaps;
}

const LatestText = Schema.Struct({ text: Schema.String, revision: DbSafeInt });

/**
 * Records one finalized window atomically (serialized per epoch) and returns the inserted segments.
 * A window inside a meeting that was sealed before its transcript was complete (a live answer that
 * outlived the close, or batch reconciliation of a gap) finalizes that meeting again.
 */
export const recordFinalWindow = (input: FinalWindow) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { workspace_id, epoch_id, track } = input;
    const latestAt = SqlSchema.findOne({
      Request: Schema.Struct({ sample_start: Schema.Number, sample_end: Schema.Number }),
      Result: LatestText,
      execute: span => sql`
        SELECT text, revision FROM transcript_segments
        WHERE workspace_id = ${workspace_id} AND epoch_id = ${epoch_id} AND track = ${track} AND status = 'final'
          AND sample_start = ${span.sample_start} AND sample_end = ${span.sample_end}
        ORDER BY revision DESC LIMIT 1`,
    });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT id FROM capture_epochs WHERE workspace_id = ${workspace_id} AND id = ${epoch_id} FOR UPDATE`;
        if (!(yield* workspaceIsLive(workspace_id))) return [];
        const covered = yield* coverageIn(workspace_id, epoch_id, track, input.window);
        const inserted: Array<string> = [];
        // A segment whose midpoint another origin already covered duplicates live/replayed audio.
        const fresh = input.segments.filter(segment => {
          const midpoint = (segment.sample_start + segment.sample_end) / 2;
          const duplicate = covered.some(range => range.origin !== input.origin && range.sample_start <= midpoint && midpoint < range.sample_end);
          return !duplicate && segment.text.trim() !== '' && segment.sample_end > segment.sample_start;
        });
        for (const segment of fresh) {
          const latest = Option.getOrNull(yield* latestAt(segment).pipe(Effect.catchTag('ParseError', Effect.die)));
          if (latest?.text === segment.text) continue;
          const id = randomUUID();
          yield* sql`
            INSERT INTO transcript_segments (id, workspace_id, epoch_id, track, sample_start, sample_end, text, status, revision, origin, provider, model,
                                             provider_connection_id, speaker_label, confidence, created_at)
            VALUES (${id}, ${workspace_id}, ${epoch_id}, ${track}, ${segment.sample_start}, ${segment.sample_end}, ${segment.text}, 'final',
                    ${(latest?.revision ?? 0) + 1}, ${input.origin}, ${input.provider}, ${input.model}, ${input.provider_connection_id},
                    ${segment.speaker_label}, ${segment.confidence}, UTC_TIMESTAMP(6))`;
          inserted.push(id);
        }
        yield* sql`
          INSERT INTO transcript_coverage (workspace_id, epoch_id, track, sample_start, sample_end, origin, created_at)
          VALUES (${workspace_id}, ${epoch_id}, ${track}, ${input.window.sample_start}, ${input.window.sample_end}, ${input.origin}, UTC_TIMESTAMP(6)) AS new
          ON DUPLICATE KEY UPDATE sample_end = GREATEST(transcript_coverage.sample_end, new.sample_end)`;
        const sealed = yield* sql<{ id: MeetingId }>`SELECT DISTINCT m.id FROM meetings m
          JOIN meeting_ranges r ON r.meeting_id = m.id AND r.boundary_revision = m.boundary_revision
          WHERE r.workspace_id = ${workspace_id} AND r.epoch_id = ${epoch_id} AND r.track = ${track}
            AND r.sample_start < ${input.window.sample_end} AND r.sample_end > ${input.window.sample_start}
            AND m.state NOT IN ${sql.in(OPEN_STATES)} AND m.processing->>'$.transcript' <> 'complete'`;
        for (const meeting of sealed) yield* scheduleFinalize({ id: meeting.id, workspace_id }, null);
        return inserted.length === 0 ? [] : yield* segmentsWhere(sql => sql`workspace_id = ${workspace_id} AND ${sql.in('id', inserted)}`);
      }),
    );
  });

/** Records a final window and hands any new segments to meeting assignment. */
export const publishFinalWindow = (input: FinalWindow & { readonly listener_id: ListenerId; readonly capture_group_id: string | null }) =>
  Effect.gen(function* () {
    const segments = yield* recordFinalWindow(input);
    if (segments.length > 0) {
      yield* onFinalSegments({ workspace_id: input.workspace_id, listener_id: input.listener_id, capture_group_id: input.capture_group_id, segments });
    }
    return segments;
  });
