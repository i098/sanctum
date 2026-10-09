/** Meeting rows, revisioned source ranges and their sample clocks, shared by lifecycle, corrections and playback. */
import { randomUUID } from 'node:crypto';
import { SqlClient, SqlError, SqlSchema } from '@effect/sql';
import {
  type BoundaryDecision,
  CaptureEpochId,
  IanaTimeZone,
  JobFailure,
  ListenerId,
  type Meeting,
  MeetingId,
  MeetingProcessing,
  MeetingState,
  type PrincipalId,
  type SourceRange,
  Unavailable,
  WorkspaceId,
} from '@sanctum/contracts';
import { Effect, Option, ParseResult, Schema } from 'effect';
import { appendContextEvent } from './context-events.ts';
import { DbJson, DbSafeInt, DbUtc } from './db.ts';
import { enqueueJob } from './jobs.ts';

/** Column list decoded by `MeetingRow`; `prefix` is a table alias such as `m.`. */
export const meetingColumns = (prefix = '') =>
  ['id', 'workspace_id', 'listener_id', 'capture_group_id', 'state', 'title', 'started_at', 'ended_at', 'timezone', 'boundary_revision', 'visibility', 'processing']
    .map(column => prefix + column)
    .join(', ');

export const OPEN_STATES: ReadonlyArray<MeetingState> = ['provisional', 'active'];
export const PENDING_PROCESSING = { transcript: 'pending', notes: 'pending', memory: 'pending', recording: 'pending' } as const;

export const MeetingRow = Schema.Struct({
  id: MeetingId,
  workspace_id: WorkspaceId,
  listener_id: Schema.NullOr(ListenerId),
  capture_group_id: Schema.NullOr(Schema.String),
  state: MeetingState,
  title: Schema.NullOr(Schema.String),
  started_at: DbUtc,
  ended_at: Schema.NullOr(DbUtc),
  timezone: IanaTimeZone,
  boundary_revision: DbSafeInt,
  visibility: Schema.Literal('restricted', 'workspace'),
  processing: DbJson(MeetingProcessing),
});
export type MeetingRow = typeof MeetingRow.Type;

export const toMeeting = ({ listener_id: _listener, capture_group_id: _group, ...meeting }: MeetingRow): Meeting => meeting;

/** One meeting row, optionally locked for the rest of the caller's transaction. */
export const selectMeeting = (workspace_id: WorkspaceId, id: MeetingId, lock = false) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    SqlSchema.findOne({
      Request: MeetingId,
      Result: MeetingRow,
      execute: meeting => sql`SELECT ${sql.literal(meetingColumns())} FROM meetings WHERE workspace_id = ${workspace_id} AND id = ${meeting} ${lock ? sql`FOR UPDATE` : sql``}`,
    })(id),
  );

/** Wire view of a meeting the caller was already authorized for. */
export const readMeeting = (workspace_id: WorkspaceId, id: MeetingId) => Effect.map(selectMeeting(workspace_id, id), row => toMeeting(Option.getOrThrow(row)));

/** The newest open meeting this listener captures, if any (requested speech and the agent-work feed). */
export const listenerMeeting = (workspace_id: WorkspaceId, listener_id: ListenerId) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    SqlSchema.findOne({
      Request: ListenerId,
      Result: Schema.Struct({ id: MeetingId }),
      execute: listener => sql`SELECT id FROM meetings WHERE workspace_id = ${workspace_id} AND listener_id = ${listener}
        AND state IN ${sql.in(OPEN_STATES)} ORDER BY started_at DESC LIMIT 1`,
    })(listener_id),
  ).pipe(Effect.map(Option.map(row => row.id)));

const EpochClock = Schema.Struct({
  id: CaptureEpochId,
  sample_start: DbSafeInt,
  sample_rate: DbSafeInt,
  captured_at: DbUtc,
  timezone: IanaTimeZone,
});
export type EpochClock = typeof EpochClock.Type;

/** Wall-clock milliseconds of a sample, derived from the epoch's anchor and sample count, never from append time. */
export const sampleMs = (epoch: EpochClock, sample: number) => Date.parse(epoch.captured_at) + ((sample - epoch.sample_start) * 1000) / epoch.sample_rate;

export const msToSample = (epoch: EpochClock, ms: number) => epoch.sample_start + Math.round(((ms - Date.parse(epoch.captured_at)) * epoch.sample_rate) / 1000);

/** DATETIME(6) parameter for a millisecond instant. */
export const dbTime = (ms: number) => new Date(ms).toISOString().slice(0, -1).replace('T', ' ');

export const loadEpochs = (workspace_id: WorkspaceId, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (ids.length === 0) return new Map<string, EpochClock>();
    const rows = yield* SqlSchema.findAll({
      Request: Schema.Array(Schema.String),
      Result: EpochClock,
      execute: keys => sql`SELECT id, sample_start, sample_rate, captured_at, timezone FROM capture_epochs WHERE workspace_id = ${workspace_id} AND id IN ${sql.in(keys)}`,
    })(ids);
    return new Map(rows.map(row => [row.id, row]));
  });

export interface TimedRange extends SourceRange {
  readonly epoch: EpochClock;
  readonly start_ms: number;
  readonly end_ms: number;
}

const RangeRow = Schema.Struct({
  epoch_id: CaptureEpochId,
  track: Schema.Number,
  sample_start: DbSafeInt,
  sample_end: DbSafeInt,
  epoch_start: DbSafeInt,
  sample_rate: DbSafeInt,
  captured_at: DbUtc,
  timezone: IanaTimeZone,
});

/** The meeting's ranges at its current boundary revision, in wall-clock order. */
export const currentRanges = (workspace_id: WorkspaceId, meeting_id: MeetingId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* SqlSchema.findAll({
      Request: MeetingId,
      Result: RangeRow,
      execute: id => sql`SELECT r.epoch_id, r.track, r.sample_start, r.sample_end, e.sample_start AS epoch_start, e.sample_rate, e.captured_at, e.timezone
        FROM meeting_ranges r
        JOIN meetings m ON m.id = r.meeting_id AND m.boundary_revision = r.boundary_revision
        JOIN capture_epochs e ON e.workspace_id = r.workspace_id AND e.id = r.epoch_id
        WHERE r.workspace_id = ${workspace_id} AND r.meeting_id = ${id}`,
    })(meeting_id);
    return rows
      .map((row): TimedRange => {
        const epoch = { id: row.epoch_id, sample_start: row.epoch_start, sample_rate: row.sample_rate, captured_at: row.captured_at, timezone: row.timezone };
        const source = { epoch_id: row.epoch_id, track: row.track, sample_start: row.sample_start, sample_end: row.sample_end };
        return { ...source, epoch, start_ms: sampleMs(epoch, row.sample_start), end_ms: sampleMs(epoch, row.sample_end) };
      })
      .sort((a, b) => a.start_ms - b.start_ms || a.track - b.track);
  });

export const insertRanges = (workspace_id: WorkspaceId, meeting_id: MeetingId, revision: number, ranges: ReadonlyArray<SourceRange>) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    ranges.length === 0
      ? Effect.void
      : sql`INSERT INTO meeting_ranges ${sql.insert(ranges.map(range => ({ workspace_id, meeting_id, boundary_revision: revision, ...range })))}`.pipe(Effect.asVoid),
  );

/** Start of the next range any meeting currently owns on this epoch/track after `sample`, so a new range never overlaps one. */
export const nextOwnedStart = (workspace_id: WorkspaceId, source: Pick<SourceRange, 'epoch_id' | 'track'>, sample: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ next: string | number | null }>`SELECT MIN(r.sample_start) AS next FROM meeting_ranges r
      JOIN meetings m ON m.id = r.meeting_id AND m.boundary_revision = r.boundary_revision
      WHERE r.workspace_id = ${workspace_id} AND r.epoch_id = ${source.epoch_id} AND r.track = ${source.track} AND r.sample_start > ${sample}`;
    return row?.next === null || row?.next === undefined ? null : Number(row.next);
  });

export const recordBoundary = (input: {
  readonly meeting: Pick<MeetingRow, 'id' | 'workspace_id'>;
  readonly revision: number;
  readonly operation: 'start' | 'promote' | 'close' | 'split' | 'merge' | 'interrupt';
  readonly decision: BoundaryDecision & Record<string, unknown>;
  readonly actor: PrincipalId | null;
}) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    sql`INSERT INTO boundary_events (id, workspace_id, meeting_id, boundary_revision, operation, decision, actor_principal_id, created_at)
      VALUES (${randomUUID()}, ${input.meeting.workspace_id}, ${input.meeting.id}, ${input.revision}, ${input.operation}, ${JSON.stringify(input.decision)}, ${input.actor}, UTC_TIMESTAMP(6))`,
  );

/** A boundary revision of a meeting entering the committed-order context feed; shared by split, merge and late joins. */
export const boundaryChanged = (meeting: Pick<MeetingRow, 'id' | 'workspace_id'>, revision: number, actor: PrincipalId) =>
  appendContextEvent({ workspace_id: meeting.workspace_id, meeting_id: meeting.id, item: null, change: 'meeting_boundary_changed', actor, source_revision: revision });

/** Sealed meetings get their final work as durable jobs; nothing waits on actions or on the listener. */
export const scheduleFinalize = (meeting: Pick<MeetingRow, 'id' | 'workspace_id'>, requested_by: PrincipalId | null) =>
  enqueueJob({ workspace_id: meeting.workspace_id, kind: 'meeting.finalize', work_key: `meeting:${meeting.id}`, payload: { meeting_id: meeting.id }, requested_by });

/** The part of a claimed ledger job these handlers read; structural so job-handlers.ts imports the handlers without a cycle. */
export interface MeetingJob {
  readonly workspace_id: WorkspaceId;
  readonly payload: unknown;
  readonly requested_by: PrincipalId | null;
}

export const MeetingJobPayload = Schema.Struct({ meeting_id: MeetingId });

/** API boundary: a database failure is a retryable outage; an undecodable row is a defect. */
export const dbFailures = <A, E, R>(effect: Effect.Effect<A, E | SqlError.SqlError | ParseResult.ParseError, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is SqlError.SqlError | ParseResult.ParseError => error instanceof SqlError.SqlError || ParseResult.isParseError(error),
      error => (error._tag === 'SqlError' ? new Unavailable({ message: 'Database unavailable', retryable: true }) : Effect.die(error)),
    ),
  );

/** Worker boundary: database, storage and retryable provider failures retry; undecodable rows or payloads do not. */
export const asJobResult = <A, R>(effect: Effect.Effect<A, { readonly _tag: string; readonly message: string; readonly retryable?: boolean }, R>) =>
  effect.pipe(
    Effect.map(result => ({ status: 'succeeded' as const, result })),
    Effect.mapError(error =>
      error instanceof JobFailure
        ? error
        : new JobFailure({ message: error.message, retryable: error._tag === 'SqlError' || error._tag === 'ObjectStoreError' || error.retryable === true }),
    ),
  );
