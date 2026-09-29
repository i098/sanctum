/**
 * A meeting's current evidence as extraction and notes read it: the meeting row as the contracts
 * `Meeting`, its final segments under the current boundary revision, and their epoch anchors.
 */
import { SqlClient } from '@effect/sql';
import { CaptureEpochId, Meeting, type MeetingId, MeetingProcessing, type TranscriptSegment, type WorkspaceId } from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { decodeRows, type SegmentRow, segmentRows } from './context-changes.ts';
import { DbJson, DbSafeInt, DbUtc } from './db.ts';

export const EpochAnchorRow = Schema.Struct({ epoch_id: CaptureEpochId, sample_rate: Schema.Number, sample_start: DbSafeInt, captured_at: DbUtc });

export const MeetingRow = Schema.Struct({
 ...Meeting.fields,
 started_at: DbUtc,
 ended_at: Schema.NullOr(DbUtc),
 processing: DbJson(MeetingProcessing),
});

export const toSegment = (row: SegmentRow): TranscriptSegment => ({
 id: row.id,
 source: { epoch_id: row.epoch_id, track: row.track, sample_start: row.sample_start, sample_end: row.sample_end },
 text: row.text,
 status: row.status,
 revision: row.revision,
 origin: row.origin,
 provider: row.provider,
 model: row.model,
 provider_connection_id: row.provider_connection_id,
 speaker_label: row.speaker_label,
 speaker_track_id: row.speaker_track_id,
 confidence: row.confidence,
 created_at: row.created_at,
});

/** A meeting row decoded as the contracts `Meeting`, or undefined. */
export const loadMeeting = (workspace_id: WorkspaceId, meeting_id: MeetingId) =>
 Effect.flatMap(SqlClient.SqlClient, sql =>
  Effect.map(decodeRows(MeetingRow, sql`SELECT * FROM meetings WHERE workspace_id = ${workspace_id} AND id = ${meeting_id}`), rows => rows[0]),
 );

/** Final segments currently owned by the meeting plus their epoch anchors, as extraction and notes consume them. */
export const meetingEvidence = (workspace_id: WorkspaceId, meeting_id: MeetingId, limit: number) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* segmentRows(workspace_id, sql`m.id = ${meeting_id} AND s.status = 'final'`, limit);
  const epochIds = [...new Set(rows.map(segment => segment.epoch_id))];
  const epochs = epochIds.length === 0 ? [] : yield* decodeRows(
   EpochAnchorRow,
   sql`SELECT id AS epoch_id, sample_rate, sample_start, captured_at FROM capture_epochs WHERE workspace_id = ${workspace_id} AND ${sql.in('id', epochIds)}`,
  );
  return { segments: rows.map(toSegment), epochs };
 });
