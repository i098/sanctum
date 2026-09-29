/**
 * Durable job handler registry. Each slice adds exactly one entry per job kind it owns;
 * the kernel's `runWorker` (jobs.ts) claims ledger rows and dispatches here.
 */
import type { SqlClient } from '@effect/sql';
import type { JobFailure, JobId, JobKind, PrincipalId, WorkspaceId } from '@sanctum/contracts';
import type { Effect } from 'effect';
import { finalizeMeeting } from './meetings.ts';
import type { ObjectStore } from './object-store.ts';
import { assembleRecording } from './playback.ts';
import type { PyannoteClient } from './providers/pyannote.ts';
import { refineSpeakers } from './speakers.ts';

export interface ClaimedJob {
  readonly id: JobId;
  readonly workspace_id: WorkspaceId;
  readonly kind: JobKind;
  readonly work_key: string;
  /** Decoded by the handler with its own schema. */
  readonly payload: unknown;
  /** Principal the job acts for; handlers re-resolve access before touching scoped data. */
  readonly requested_by: PrincipalId | null;
  readonly source_revision: number | null;
  readonly attempt: number;
  /** Fencing token: completion writes must match it. */
  readonly lease_generation: number;
}

export type JobOutcome =
  | { readonly status: 'succeeded'; readonly result: unknown }
  /** Budget or rate limit reached: park until `resume_after_ms` instead of silently stopping. */
  | { readonly status: 'paused'; readonly resume_after_ms: number; readonly reason: string };

/** Services every worker handler may use; a slice adds its provider tag here and its layer in worker.ts. */
export type WorkerServices = SqlClient.SqlClient | ObjectStore | PyannoteClient;

export type JobHandler<R = WorkerServices> = (job: ClaimedJob) => Effect.Effect<JobOutcome, JobFailure, R>;

/** Handlers by kind; `runWorker` requires exactly the services its handlers use. */
export type JobHandlers<R = WorkerServices> = Partial<Record<JobKind, JobHandler<R>>>;

export const jobHandlers: JobHandlers = {
  // One line per slice, e.g. 'context.refresh': refreshContext,
  'meeting.finalize': finalizeMeeting,
  'recording.assemble': assembleRecording,
  'speakers.refine': refineSpeakers,
};
