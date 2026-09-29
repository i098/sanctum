// stand-in: replaced by the kernel slice at integration
/** Job ledger core: enqueue, SKIP LOCKED claim, lease, fenced completion, bounded retry, worker loop. */
import { randomUUID } from 'node:crypto';
import { SqlClient, type SqlError } from '@effect/sql';
import { JobId, type JobKind, type PrincipalId, type WorkspaceId } from '@sanctum/contracts';
import { Effect } from 'effect';
import type { ClaimedJob, JobHandler, WorkerServices } from './job-handlers.ts';

export interface EnqueueJob {
  readonly workspace_id: WorkspaceId;
  readonly kind: JobKind;
  readonly work_key: string;
  readonly payload: unknown;
  readonly requested_by: PrincipalId | null;
  readonly source_revision?: number;
  readonly delay_ms?: number;
  readonly max_attempts?: number;
}

const LEASE_SECONDS = 60;
const POLL_MS = 200;

/** Joins the caller's transaction; an active row with the same key is re-armed instead of duplicated. */
export const enqueueJob = (input: EnqueueJob) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const delay = (input.delay_ms ?? 0) * 1000;
    yield* sql`
      INSERT INTO jobs (id, workspace_id, kind, work_key, requested_by, source_revision, status, payload, available_at, max_attempts, created_at, updated_at)
      VALUES (${randomUUID()}, ${input.workspace_id}, ${input.kind}, ${input.work_key}, ${input.requested_by}, ${input.source_revision ?? null}, 'pending',
        ${JSON.stringify(input.payload)}, UTC_TIMESTAMP(6) + INTERVAL ${delay} MICROSECOND, ${input.max_attempts ?? 3}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
      ON DUPLICATE KEY UPDATE payload = VALUES(payload), available_at = VALUES(available_at), updated_at = VALUES(updated_at)`;
    const [row] = yield* sql<{ id: string }>`
      SELECT id FROM jobs WHERE workspace_id = ${input.workspace_id} AND kind = ${input.kind} AND active_work_key = ${input.work_key}`;
    return JobId.make(row!.id);
  });

interface JobRow { id: string; workspace_id: string; kind: JobKind; work_key: string; payload: unknown; requested_by: string | null; source_revision: string | null; attempts: number; max_attempts: number; lease_generation: string }

/** Claims one due or lease-expired job and commits the lease before any handler runs. */
const claim = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [row] = yield* sql<JobRow>`
        SELECT id, workspace_id, kind, work_key, payload, requested_by, source_revision, attempts, max_attempts, lease_generation FROM jobs
        WHERE (status IN ('pending', 'paused') AND available_at <= UTC_TIMESTAMP(6)) OR (status = 'running' AND lease_until < UTC_TIMESTAMP(6))
        ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!row) return null;
      const generation = Number(row.lease_generation) + 1;
      yield* sql`
        UPDATE jobs SET status = 'running', lease_token = ${randomUUID()}, lease_generation = ${generation}, attempts = attempts + 1,
          lease_until = UTC_TIMESTAMP(6) + INTERVAL ${LEASE_SECONDS} SECOND, updated_at = UTC_TIMESTAMP(6) WHERE id = ${row.id}`;
      return {
        id: JobId.make(row.id),
        workspace_id: row.workspace_id as WorkspaceId,
        kind: row.kind,
        work_key: row.work_key,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        requested_by: row.requested_by as PrincipalId | null,
        source_revision: row.source_revision === null ? null : Number(row.source_revision),
        attempt: row.attempts + 1,
        lease_generation: generation,
        max_attempts: row.max_attempts,
      } satisfies ClaimedJob & { max_attempts: number };
    }),
  );
});

/** Every completion write is fenced by the lease generation, so a late worker cannot overwrite a newer claim. */
const run = (job: ClaimedJob & { max_attempts: number }, handler: JobHandler | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fence = sql`id = ${job.id} AND lease_generation = ${job.lease_generation}`;
    if (!handler) {
      return yield* sql`UPDATE jobs SET status = 'failed', last_error = ${JSON.stringify({ message: `No handler for ${job.kind}` })}, updated_at = UTC_TIMESTAMP(6) WHERE ${fence}`;
    }
    const outcome = yield* Effect.either(handler(job));
    if (outcome._tag === 'Left') {
      const retry = outcome.left.retryable && job.attempt < job.max_attempts;
      return yield* sql`
        UPDATE jobs SET status = ${retry ? 'pending' : 'failed'}, available_at = UTC_TIMESTAMP(6) + INTERVAL ${job.attempt} SECOND,
          last_error = ${JSON.stringify({ message: outcome.left.message })}, lease_until = NULL, updated_at = UTC_TIMESTAMP(6) WHERE ${fence}`;
    }
    const done = outcome.right;
    if (done.status === 'paused') {
      // A budget pause does not consume an attempt.
      return yield* sql`
        UPDATE jobs SET status = 'paused', attempts = attempts - 1, available_at = UTC_TIMESTAMP(6) + INTERVAL ${done.resume_after_ms * 1000} MICROSECOND,
          last_error = ${JSON.stringify({ message: done.reason })}, lease_until = NULL, updated_at = UTC_TIMESTAMP(6) WHERE ${fence}`;
    }
    yield* sql`
      UPDATE jobs SET status = 'succeeded', result = ${JSON.stringify(done.result ?? null)}, lease_until = NULL, updated_at = UTC_TIMESTAMP(6) WHERE ${fence}`;
  }).pipe(Effect.asVoid);

export const runWorker = (handlers: Partial<Record<JobKind, JobHandler>>): Effect.Effect<never, SqlError.SqlError, WorkerServices> =>
  Effect.forever(
    Effect.flatMap(claim, job => (job === null ? Effect.sleep(POLL_MS) : run(job, handlers[job.kind]))),
  );
