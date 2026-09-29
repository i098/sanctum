/**
 * Final meeting notes (plan sections 06, 08 and 09): after a meeting closes, and again after
 * boundary or attribution corrections re-finalize it, `notes.summarize` asks the extraction role
 * for the one canonical structured summary and stores it on the meeting with its revision.
 * Failures keep every source and mark notes `failed`; nothing is invented.
 */
import { SqlClient } from '@effect/sql';
import { JobFailure, MeetingId, type WorkspaceId } from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { summarizeMeeting } from './extraction.ts';
import { loadMeeting, meetingEvidence } from './meeting-evidence.ts';

/** Enough final transcript for any meeting the extraction role can summarize in one request. */
const MAX_SEGMENTS = 5_000;
const OPEN = ['provisional', 'active', 'closing'];

const Payload = Schema.Struct({ meeting_id: MeetingId });

const markFailed = (workspace_id: WorkspaceId, meeting_id: MeetingId) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    sql`UPDATE meetings SET processing = JSON_SET(processing, '$.notes', 'failed'), updated_at = UTC_TIMESTAMP(6)
      WHERE workspace_id = ${workspace_id} AND id = ${meeting_id}`,
  );

/** `notes.summarize` handler: payload `{ meeting_id }`, work key `meeting:<id>`. */
export const summarizeNotes = (job: { readonly workspace_id: WorkspaceId; readonly payload: unknown }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = yield* Schema.decodeUnknown(Payload)(job.payload);
    const meeting = yield* loadMeeting(job.workspace_id, payload.meeting_id);
    if (meeting === undefined) return yield* new JobFailure({ message: 'Meeting not found', retryable: false });
    if (OPEN.includes(meeting.state)) return { status: 'succeeded', result: { skipped: 'meeting is still open' } } as const;
    const { segments, epochs } = yield* meetingEvidence(job.workspace_id, meeting.id, MAX_SEGMENTS);
    const notes = yield* summarizeMeeting({ meeting, segments, epochs }).pipe(
      Effect.mapError(error => new JobFailure({ message: error.message, retryable: error.retryable })),
      Effect.tapError(() => markFailed(job.workspace_id, meeting.id)),
    );
    const stored = { ...notes, boundary_revision: meeting.boundary_revision, generated_at: new Date().toISOString() };
    const updated = yield* sql`UPDATE meetings SET notes = ${JSON.stringify(stored)}, notes_revision = notes_revision + 1,
        processing = JSON_SET(processing, '$.notes', 'complete'), updated_at = UTC_TIMESTAMP(6)
      WHERE workspace_id = ${job.workspace_id} AND id = ${meeting.id} AND boundary_revision = ${meeting.boundary_revision}`.raw;
    const affected = typeof updated === 'object' && updated !== null && 'affectedRows' in updated ? Number(updated.affectedRows) : 0;
    // A boundary change during summarization re-finalizes the meeting, which schedules fresh notes.
    if (affected === 0) return { status: 'succeeded', result: { skipped: 'boundaries changed during summarization' } } as const;
    return { status: 'succeeded', result: { meeting_id: meeting.id, points: notes.sections.reduce((total, section) => total + section.points.length, 0) } } as const;
  }).pipe(
    Effect.catchTags({
      ParseError: error => new JobFailure({ message: error.message, retryable: false }),
      SqlError: error => new JobFailure({ message: error.message, retryable: true }),
    }),
  );

