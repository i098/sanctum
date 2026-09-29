/** Job handler contract shared by the ledger (jobs.ts), the registry (job-handlers.ts) and handler modules. */
import type { JobFailure, JobId, JobKind, PrincipalId, WorkspaceId } from '@sanctum/contracts';
import type { Effect } from 'effect';

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

export type JobHandler<R> = (job: ClaimedJob) => Effect.Effect<JobOutcome, JobFailure, R>;

/** Handlers by kind; `runWorker` requires exactly the services its handlers use. */
export type JobHandlers<R> = Partial<Record<JobKind, JobHandler<R>>>;
