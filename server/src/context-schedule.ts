/**
 * Enqueues context work on the job ledger. The work key is the meeting, so at most one job per
 * meeting and kind is active and later arrivals coalesce into it (plan sections 02 and 08).
 */
import type { MeetingId, PrincipalId, WorkspaceId } from '@sanctum/contracts';
import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';
import { engineeringDefaults } from './config.ts';
import { enqueueJob } from './jobs.ts';

/** Schedules a refresh after the quiet period, or at once when enough new turns arrived; `requested_by` null is the system actor. */
export const requestContextRefresh = (input: { readonly workspace_id: WorkspaceId; readonly meeting_id: MeetingId; readonly requested_by: PrincipalId | null; readonly new_turns: number }) =>
 enqueueJob({
  workspace_id: input.workspace_id,
  kind: 'context.refresh',
  work_key: input.meeting_id,
  payload: { meeting_id: input.meeting_id },
  requested_by: input.requested_by,
  ...(input.new_turns >= engineeringDefaults.contextJob.turnThreshold
   ? { delay_ms: 0, expedite: true }
   : { delay_ms: engineeringDefaults.contextJob.quietPeriodMs }),
 });

/** Live refresh after new final speech; the meeting's unprocessed turn count picks the quiet period or an immediate run. */
export const requestLiveContextRefresh = (workspace_id: WorkspaceId, meeting_id: MeetingId) =>
 Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ turns: number }>`SELECT COUNT(*) AS turns FROM transcript_segments s
   JOIN meeting_ranges r ON r.workspace_id = s.workspace_id AND r.epoch_id = s.epoch_id AND r.track = s.track
    AND s.sample_start >= r.sample_start AND s.sample_start < r.sample_end
   JOIN meetings m ON m.workspace_id = r.workspace_id AND m.id = r.meeting_id AND m.boundary_revision = r.boundary_revision
   WHERE s.workspace_id = ${workspace_id} AND m.id = ${meeting_id} AND s.status = 'final'
    AND NOT EXISTS (SELECT 1 FROM context_processed_segments p WHERE p.workspace_id = s.workspace_id AND p.meeting_id = m.id AND p.segment_id = s.id)`;
  return yield* requestContextRefresh({ workspace_id, meeting_id, requested_by: null, new_turns: Number(rows[0]?.turns ?? 0) });
 });

/** Schedules distillation into committed memory, e.g. when a meeting closes. */
export const requestMemoryCommit = (input: { readonly workspace_id: WorkspaceId; readonly meeting_id: MeetingId; readonly requested_by: PrincipalId }) =>
 enqueueJob({ workspace_id: input.workspace_id, kind: 'memory.commit', work_key: input.meeting_id, payload: { meeting_id: input.meeting_id }, requested_by: input.requested_by });
