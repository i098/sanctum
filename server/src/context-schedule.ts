/**
 * Enqueues context work on the job ledger. The work key is the meeting, so at most one job per
 * meeting and kind is active and later arrivals coalesce into it (plan sections 02 and 08).
 */
import type { MeetingId, PrincipalId, WorkspaceId } from '@sanctum/contracts';
import { engineeringDefaults } from './config.ts';
import { enqueueJob } from './jobs.ts';

/** Schedules a refresh after the quiet period, or at once when enough new turns arrived. */
export const requestContextRefresh = (input: { readonly workspace_id: WorkspaceId; readonly meeting_id: MeetingId; readonly requested_by: PrincipalId; readonly new_turns: number }) =>
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

/** Schedules distillation into committed memory, e.g. when a meeting closes. */
export const requestMemoryCommit = (input: { readonly workspace_id: WorkspaceId; readonly meeting_id: MeetingId; readonly requested_by: PrincipalId }) =>
 enqueueJob({ workspace_id: input.workspace_id, kind: 'memory.commit', work_key: input.meeting_id, payload: { meeting_id: input.meeting_id }, requested_by: input.requested_by });
