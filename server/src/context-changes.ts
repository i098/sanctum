/**
 * Read side of shared context (plan sections 07 and 08): authorized evidence lookup and the
 * committed-order change feed. Final segments are located in their meeting through the current
 * boundary revision, with UTC and meeting-relative times computed from sample offsets. Every
 * read is filtered to meetings the caller may see; hidden and missing look the same.
 *
 * Change cursors are bound to the workspace, principal and permission revision they were issued
 * under: after any access change the caller reloads a snapshot instead of resuming a feed that
 * could reflect revoked scope.
 */
import { SqlClient, type SqlError, SqlSchema, type Statement } from '@effect/sql';
import {
 type AccessScope,
 ArtifactId,
 CaptureEpochId,
 ContextChangeKind,
 type ContextChanges,
 ContextItemId,
 MeetingId,
 NotFound,
 PrincipalId,
 ProviderConnectionId,
 Revision,
 RevisionConflict,
 type SourceRef,
 SpeakerTrackId,
 TranscriptSegmentId,
 TranscriptSource,
} from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { listVisibleMeetingIds, requireScope } from './auth.ts';
import { DbSafeInt, DbSha256, DbUtc } from './db.ts';

/** Runs `statement` and decodes its rows; an undecodable row is schema drift (a defect), SQL errors stay typed. */
export const decodeRows = <A, I>(schema: Schema.Schema<A, I>, statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
 SqlSchema.findAll({ Request: Schema.Void, Result: schema, execute: () => statement })(undefined).pipe(Effect.catchTag('ParseError', Effect.die));

const SegmentColumns = Schema.Struct({
 id: TranscriptSegmentId,
 meeting_id: MeetingId,
 epoch_id: CaptureEpochId,
 track: Schema.Number,
 sample_start: DbSafeInt,
 sample_end: DbSafeInt,
 text: Schema.String,
 status: Schema.Literal('partial', 'final'),
 revision: Revision,
 origin: TranscriptSource,
 provider: Schema.String,
 model: Schema.String,
 provider_connection_id: Schema.NullOr(ProviderConnectionId),
 speaker_label: Schema.NullOr(Schema.String),
 speaker_track_id: Schema.NullOr(SpeakerTrackId),
 confidence: Schema.NullOr(Schema.Number),
 created_at: DbUtc,
 event_at: DbUtc,
 start_ms: DbSafeInt,
 end_ms: DbSafeInt,
});
export type SegmentRow = typeof SegmentColumns.Type;

/**
 * Segments of `workspace_id` matching `filter` (a fragment over alias `s` and `m`), each in the
 * meeting whose current boundary revision owns its first sample. Chronological order.
 */
export const segmentRows = (workspace_id: string, filter: Statement.Fragment, limit = 1000) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const at = (sample: string) => sql.literal(`DATE_ADD(e.captured_at, INTERVAL (CAST(${sample} AS SIGNED) - CAST(e.sample_start AS SIGNED)) * 1000000 DIV e.sample_rate MICROSECOND)`);
  return yield* decodeRows(
   SegmentColumns,
   sql`SELECT s.id, m.id AS meeting_id, s.epoch_id, s.track, s.sample_start, s.sample_end, s.text, s.status, s.revision,
          s.origin, s.provider, s.model, s.provider_connection_id, s.speaker_label, s.speaker_track_id, s.confidence, s.created_at,
          ${at('s.sample_start')} AS event_at,
          GREATEST(0, TIMESTAMPDIFF(MICROSECOND, m.started_at, ${at('s.sample_start')}) DIV 1000) AS start_ms,
          GREATEST(0, TIMESTAMPDIFF(MICROSECOND, m.started_at, ${at('s.sample_end')}) DIV 1000) AS end_ms
        FROM transcript_segments s
        JOIN capture_epochs e ON e.workspace_id = s.workspace_id AND e.id = s.epoch_id
        JOIN meeting_ranges r ON r.workspace_id = s.workspace_id AND r.epoch_id = s.epoch_id AND r.track = s.track
          AND s.sample_start >= r.sample_start AND s.sample_start < r.sample_end
        JOIN meetings m ON m.workspace_id = r.workspace_id AND m.id = r.meeting_id AND m.boundary_revision = r.boundary_revision
        WHERE s.workspace_id = ${workspace_id} AND ${filter}
        ORDER BY e.captured_at, s.sample_start, s.id
        LIMIT ${limit}`,
  );
 });

/** Meetings a caller may read; `workspaceLevel` says whether rows with no meeting are visible too. */
export interface VisibleScope {
 readonly meetings: ReadonlyArray<MeetingId>;
 readonly workspaceLevel: boolean;
}

/** Allowlist credentials never see workspace-level rows. */
export const visibleScope = (access: AccessScope) =>
 Effect.map(listVisibleMeetingIds(access), (meetings): VisibleScope => ({ meetings, workspaceLevel: access.meetings.kind === 'accessible' }));

/** SQL condition: `column` names a visible meeting, or is NULL when workspace-level rows are visible. */
export const visibleWhere = (sql: SqlClient.SqlClient, scope: VisibleScope, column: string) =>
 sql.or([sql.in(column, scope.meetings), ...(scope.workspaceLevel ? [sql`${sql(column)} IS NULL`] : [])]);

const ArtifactRow = Schema.Struct({ id: Schema.String, meeting_id: Schema.NullOr(Schema.String) });
const ArtifactView = Schema.Struct({
 id: ArtifactId,
 meeting_id: Schema.NullOr(MeetingId),
 title: Schema.String,
 content_type: Schema.String,
 content: Schema.NullOr(Schema.String),
 sha256: DbSha256,
 created_at: DbUtc,
});

/** Exact cited evidence: a transcript segment or an artifact, readable only within its own meeting's access. */
export const getSource = (access: AccessScope, id: string) =>
 Effect.gen(function*() {
  yield* requireScope(access, 'context:read');
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* visibleScope(access);
  const [segment] = yield* segmentRows(access.workspace_id, sql`s.id = ${id}`, 1);
  if (segment && scope.meetings.includes(segment.meeting_id)) {
   const { epoch_id, track, sample_start, sample_end } = segment;
   return {
    kind: 'segment' as const, id: segment.id, meeting_id: segment.meeting_id, text: segment.text, revision: segment.revision,
    speaker_label: segment.speaker_label, source: { epoch_id, track, sample_start, sample_end },
    event_at: segment.event_at, start_ms: segment.start_ms, end_ms: segment.end_ms,
   };
  }
  const [artifact] = yield* decodeRows(ArtifactView, sql`SELECT id, meeting_id, title, content_type, content, sha256, created_at FROM artifacts WHERE workspace_id = ${access.workspace_id} AND id = ${id}`);
  const readable = artifact && (artifact.meeting_id === null ? scope.workspaceLevel : scope.meetings.includes(artifact.meeting_id));
  return readable ? { kind: 'artifact' as const, ...artifact } : yield* new NotFound({ message: 'Source not found' });
 });

/**
 * Validates cited sources against the caller's access and returns them normalized: segment
 * citations get the segment's exact meeting-relative span. The earliest cited segment start is
 * the item's event time.
 */
export const resolveSources = (access: AccessScope, sources: ReadonlyArray<SourceRef>) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const segmentIds = sources.flatMap(source => ('segment_id' in source ? [source.segment_id] : []));
  const artifactIds = sources.flatMap(source => ('artifact_id' in source ? [source.artifact_id] : []));
  const scope = yield* visibleScope(access);
  const segments = segmentIds.length === 0 ? [] : yield* segmentRows(access.workspace_id, sql`s.status = 'final' AND ${sql.in('s.id', segmentIds)}`);
  const artifacts = artifactIds.length === 0
   ? []
   : yield* decodeRows(ArtifactRow, sql`SELECT id, meeting_id FROM artifacts WHERE workspace_id = ${access.workspace_id} AND ${sql.in('id', artifactIds)}`);
  const readable = new Set<string>([
   ...segments.filter(row => scope.meetings.includes(row.meeting_id)).map(row => row.id),
   ...artifacts.filter(row => (row.meeting_id === null ? scope.workspaceLevel : scope.meetings.includes(MeetingId.make(row.meeting_id)))).map(row => row.id),
  ]);
  if (![...segmentIds, ...artifactIds].every(id => readable.has(id))) return yield* new NotFound({ message: 'Cited source not found' });
  const byId = new Map(segments.map(row => [row.id, row]));
  const normalized = sources.map(source => {
   if (!('segment_id' in source)) return source;
   const row = byId.get(source.segment_id)!;
   return { segment_id: row.id, start_ms: row.start_ms, end_ms: row.end_ms };
  });
  return { sources: normalized, event_at: segmentIds.map(id => byId.get(id)!.event_at).sort()[0] ?? null, segments };
 });

const CursorBody = Schema.parseJson(Schema.Tuple(Schema.String, Schema.String, Schema.Number, Schema.Number));

/** Opaque cursor positioned after workspace sequence `seq`. */
export const encodeCursor = (access: AccessScope, seq: number) =>
 Buffer.from(JSON.stringify([access.workspace_id, access.principal.id, access.permission_revision, seq])).toString('base64url');

const cursorSeq = (access: AccessScope, cursor: string | undefined) =>
 cursor === undefined
  ? Effect.succeed(0)
  : Schema.decodeUnknown(CursorBody)(Buffer.from(cursor, 'base64url').toString()).pipe(
   Effect.mapError(() => new NotFound({ message: 'Unknown cursor' })),
   Effect.flatMap(([workspace, principal, permission, seq]): Effect.Effect<number, NotFound | RevisionConflict> => {
    if (workspace !== access.workspace_id || principal !== access.principal.id) return Effect.fail(new NotFound({ message: 'Unknown cursor' }));
    return permission === access.permission_revision
     ? Effect.succeed(seq)
     : Effect.fail(new RevisionConflict({ message: 'Access changed since this cursor was issued; reload the context snapshot', current_revision: access.permission_revision }));
   }),
  );

const EventRow = Schema.Struct({
 seq: DbSafeInt,
 meeting_id: Schema.NullOr(MeetingId),
 item_id: Schema.NullOr(ContextItemId),
 item_revision: Schema.NullOr(Revision),
 change_kind: ContextChangeKind,
 actor_principal_id: PrincipalId,
 permission_revision: DbSafeInt,
 created_at: DbUtc,
});

/** Events after `cursor` (from the start when absent) on meetings the caller may read, oldest first. */
export const getContextChanges = (access: AccessScope, input: { readonly cursor?: string | undefined; readonly limit?: number | undefined }) =>
 Effect.gen(function*() {
  yield* requireScope(access, 'context:read');
  const after = yield* cursorSeq(access, input.cursor);
  const scope = yield* visibleScope(access);
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* decodeRows(
   EventRow,
   sql`SELECT seq, meeting_id, item_id, item_revision, change_kind, actor_principal_id, permission_revision, created_at
        FROM context_events WHERE workspace_id = ${access.workspace_id} AND seq > ${after} AND ${visibleWhere(sql, scope, 'meeting_id')}
        ORDER BY seq LIMIT ${input.limit ?? 100}`,
  );
  const events = rows.map(row => ({
   seq: row.seq,
   meeting_id: row.meeting_id,
   item: row.item_id === null ? null : { id: row.item_id, revision: row.item_revision! },
   change: row.change_kind,
   actor: row.actor_principal_id,
   permission_revision: row.permission_revision,
   created_at: row.created_at,
  }));
  return { events, next_cursor: encodeCursor(access, rows.at(-1)?.seq ?? after) } satisfies ContextChanges;
 });
