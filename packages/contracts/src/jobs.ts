/** Durable MySQL job ledger rows as seen by APIs and operators. */
import { Schema } from 'effect';
import { JobId, UtcTimestamp, WorkspaceId } from './common.ts';

/** Job kinds named by the plan; a slice adds its kind here before registering a handler. */
export const JobKind = Schema.Literal(
  'context.refresh',
  'meeting.finalize',
  'transcript.reconcile',
  'recording.assemble',
  'speakers.refine',
  'memory.commit',
  'notes.summarize',
  'matching.rank',
  'research.run',
  'action.execute',
  'action.reconcile',
  'workos.sync',
  'workspace.purge',
);
export type JobKind = typeof JobKind.Type;

export const JobStatus = Schema.Literal('pending', 'running', 'succeeded', 'failed', 'cancelled', 'paused');
export type JobStatus = typeof JobStatus.Type;

export const Job = Schema.Struct({
  id: JobId,
  workspace_id: WorkspaceId,
  kind: JobKind,
  work_key: Schema.String,
  status: JobStatus,
  attempts: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  available_at: UtcTimestamp,
  lease_until: Schema.NullOr(UtcTimestamp),
  created_at: UtcTimestamp,
  updated_at: UtcTimestamp,
});
export type Job = typeof Job.Type;

/** Handler failure; stored in `jobs.last_error`. Transient failures retry with bounded backoff, others fail the job. */
export class JobFailure extends Schema.TaggedError<JobFailure>()('JobFailure', {
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}
