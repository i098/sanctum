/**
 * Worker side of the job ledger: a claim is one short transaction (`SELECT ... FOR UPDATE SKIP
 * LOCKED`, then lease token, generation and attempt written before commit); handlers run outside
 * any transaction while the lease is renewed; completion only lands if token and generation still
 * match. Deadlocks and lock wait timeouts retry a bounded number of times; handler failures retry
 * with capped backoff.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient, SqlError, SqlSchema } from '@effect/sql';
import { JobFailure, JobId, JobKind, PrincipalId, WorkspaceId } from '@sanctum/contracts';
import { Cause, Effect, Exit, Option, Schedule, Schema } from 'effect';
import { resolveAccess } from './auth.ts';
import { engineeringDefaults } from './config.ts';
import { DbSafeInt, mysqlErrno } from './db.ts';
import type { ClaimedJob, JobHandlers, JobOutcome } from './job-types.ts';
import { later, REQUESTER_REFUSED } from './jobs.ts';
import { sweepLapsedListeners } from './listeners.ts';
import { write } from './store.ts';

const ER_LOCK_WAIT_TIMEOUT = 1205;
const ER_LOCK_DEADLOCK = 1213;
const MAX_BACKOFF_MS = 5 * 60_000;

/** InnoDB rolled the whole transaction back; rerunning it is safe. */
export const retryDeadlocks = <A, R>(transaction: Effect.Effect<A, SqlError.SqlError, R>) =>
  Effect.retry(transaction, {
    schedule: Schedule.jittered(Schedule.exponential('10 millis')),
    times: 4,
    while: error => [ER_LOCK_DEADLOCK, ER_LOCK_WAIT_TIMEOUT].includes(mysqlErrno(error) ?? 0),
  });

export interface Lease {
  readonly job: ClaimedJob;
  readonly token: string;
}

const ClaimedRow = Schema.Struct({
  id: JobId,
  workspace_id: WorkspaceId,
  kind: JobKind,
  work_key: Schema.String,
  payload: Schema.Unknown,
  requested_by: Schema.NullOr(PrincipalId),
  source_revision: Schema.NullOr(DbSafeInt),
  attempt: DbSafeInt,
  lease_generation: DbSafeInt,
});

/**
 * Claims the oldest due job of `kinds`. The `(status, available_at)` index keeps the locking read
 * to one row.
 */
export const claimJob = (kinds: ReadonlyArray<JobKind>, leaseMs: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const token = randomUUID();
    const claimed = sql.withTransaction(
      Effect.gen(function* () {
        const [due] = yield* sql<{ id: JobId }>`SELECT id FROM jobs
          WHERE status = 'pending' AND available_at <= UTC_TIMESTAMP(6) AND kind IN ${sql.in(kinds)}
          ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (!due) return Option.none<Lease>();
        yield* sql`UPDATE jobs SET status = 'running', lease_token = ${token}, lease_generation = lease_generation + 1,
          lease_until = ${later(sql, leaseMs)}, attempts = attempts + 1, updated_at = UTC_TIMESTAMP(6) WHERE id = ${due.id}`;
        const job = yield* SqlSchema.single({
          Request: JobId,
          Result: ClaimedRow,
          execute: id => sql`SELECT id, workspace_id, kind, work_key, payload, requested_by, source_revision,
            attempts AS attempt, lease_generation FROM jobs WHERE id = ${id}`,
        })(due.id).pipe(Effect.orDie);
        return Option.some({ job, token });
      }),
    );
    return yield* retryDeadlocks(claimed);
  });

const fenced = (sql: SqlClient.SqlClient, lease: Lease) =>
  sql`id = ${lease.job.id} AND status = 'running' AND lease_token = ${lease.token} AND lease_generation = ${lease.job.lease_generation}`;

/** Extends the lease; false once another worker owns the row (or it was completed). */
const renewLease = (lease: Lease, leaseMs: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const renewed = yield* write(sql`UPDATE jobs SET lease_until = ${later(sql, leaseMs)} WHERE ${fenced(sql, lease)}`);
    return renewed.affectedRows === 1;
  });

export type Completion = JobOutcome | { readonly status: 'failed'; readonly error: JobFailure };

/**
 * Generation-fenced completion; false means the lease was lost and nothing was written.
 * Assignments run left to right, so `rearmed` and `attempts` are read before being reset.
 */
export const completeJob = (lease: Lease, completion: Completion) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const release = sql`lease_token = NULL, lease_until = NULL, updated_at = UTC_TIMESTAMP(6)`;
    const update = (() => {
      switch (completion.status) {
        case 'succeeded':
          return sql`UPDATE jobs SET status = IF(rearmed, 'pending', 'succeeded'), attempts = IF(rearmed, 0, attempts), rearmed = 0,
            result = ${JSON.stringify(completion.result ?? null)}, last_error = NULL, ${release} WHERE ${fenced(sql, lease)}`;
        case 'paused':
          // A budget or rate-limit pause does not consume an attempt; the resumed run uses the latest payload.
          return sql`UPDATE jobs SET status = 'paused', attempts = attempts - 1, rearmed = 0, available_at = ${later(sql, completion.resume_after_ms)},
            last_error = ${JSON.stringify({ message: completion.reason, retryable: true })}, ${release} WHERE ${fenced(sql, lease)}`;
        case 'failed': {
          const backoff = Math.min(1000 * 2 ** (lease.job.attempt - 1), MAX_BACKOFF_MS);
          return sql`UPDATE jobs SET
            status = IF(rearmed OR (${completion.error.retryable} AND attempts < max_attempts), 'pending', 'failed'),
            available_at = IF(rearmed, available_at, ${later(sql, backoff)}), attempts = IF(rearmed, 0, attempts), rearmed = 0,
            last_error = ${JSON.stringify({ message: completion.error.message, retryable: completion.error.retryable })}, ${release}
            WHERE ${fenced(sql, lease)}`;
        }
      }
    })();
    const done = yield* retryDeadlocks(write(update));
    return done.affectedRows === 1;
  });

/** Resumes due paused jobs and returns expired leases to the queue (or fails them when exhausted). */
export const sweepJobs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* retryDeadlocks(sql`UPDATE jobs SET status = 'pending', updated_at = UTC_TIMESTAMP(6) WHERE status = 'paused' AND available_at <= UTC_TIMESTAMP(6)`);
  yield* retryDeadlocks(sql`UPDATE jobs SET
      status = IF(attempts >= max_attempts AND NOT rearmed, 'failed', 'pending'), attempts = IF(rearmed, 0, attempts), rearmed = 0,
      last_error = ${JSON.stringify({ message: 'Lease expired before completion', retryable: true })},
      lease_token = NULL, lease_until = NULL, updated_at = UTC_TIMESTAMP(6)
    WHERE status = 'running' AND lease_until <= UTC_TIMESTAMP(6)`);
});

/** A handler's typed failure; a database error it died on is transient and retryable, any other defect is not. */
const failureOf = (cause: Cause.Cause<JobFailure>) =>
  Option.getOrElse(Cause.failureOption(cause), () => {
    const died = Option.getOrNull(Cause.dieOption(cause));
    return died instanceof SqlError.SqlError
      ? new JobFailure({ message: `Database error: ${died.message}`, retryable: true })
      : new JobFailure({ message: Cause.pretty(cause), retryable: false });
  });

/**
 * Re-checks the requester (the action handler does so itself to settle the action row), runs the
 * handler under its ceiling while renewing the lease, then completes the row. A ceiling hit
 * interrupts the handler and fails the attempt (already counted at claim) retryably.
 */
export const runJob = <R>(handlers: JobHandlers<R>, lease: Lease, leaseMs: number, ceilingMs: number) =>
  Effect.gen(function* () {
    const { job } = lease;
    const requester = job.requested_by;
    const refused = requester === null || job.kind === 'action.execute'
      ? null
      : yield* resolveAccess({ workspace_id: job.workspace_id, principal_id: requester }).pipe(
        Effect.as(null),
        Effect.catchAll(error => Effect.succeed(error._tag === 'Forbidden'
          ? new JobFailure({ message: REQUESTER_REFUSED, retryable: false })
          : new JobFailure({ message: error.message, retryable: true }))),
      );
    if (refused !== null) return yield* completeJob(lease, { status: 'failed', error: refused });
    const renewals = Effect.repeat(Effect.orElseSucceed(renewLease(lease, leaseMs), () => true), { schedule: Schedule.spaced(leaseMs / 3), while: renewed => renewed });
    const handled = Effect.timeoutFail(handlers[job.kind]!(job), {
      duration: ceilingMs,
      onTimeout: () => new JobFailure({ message: `Handler exceeded its ${ceilingMs} ms ceiling`, retryable: true }),
    });
    const raced = yield* Effect.raceFirst(Effect.exit(handled), Effect.as(renewals, 'lease lost' as const));
    if (raced === 'lease lost') {
      yield* Effect.logWarning(`Job ${job.id} lost its lease; another worker owns it`);
      return false;
    }
    const completion: Completion = Exit.isSuccess(raced) ? raced.value : { status: 'failed', error: failureOf(raced.cause) };
    return yield* completeJob(lease, completion);
  });

/**
 * Worker loop: `concurrency` claimers plus one sweeper. A worker without handlers idles instead
 * of claiming work that belongs to another deployment's handlers. `ceilingMs` overrides every
 * kind's configured ceiling.
 */
export const runWorker = <R>(
  handlers: JobHandlers<R>,
  options: { readonly leaseMs?: number; readonly pollMs?: number; readonly concurrency?: number; readonly ceilingMs?: number } = {},
) => {
  const { leaseMs = 60_000, pollMs = 1_000, concurrency = 4 } = options;
  const kinds = JobKind.literals.filter(kind => handlers[kind] !== undefined);
  if (kinds.length === 0) return Effect.logWarning('No job handlers registered').pipe(Effect.zipRight(Effect.never));
  const claimer = Effect.gen(function* () {
    const lease = yield* claimJob(kinds, leaseMs);
    if (Option.isNone(lease)) return yield* Effect.sleep(pollMs);
    const { kind } = lease.value.job;
    yield* runJob(handlers, lease.value, leaseMs, options.ceilingMs ?? engineeringDefaults.jobs.ceilingByKind[kind] ?? engineeringDefaults.jobs.ceilingMs);
  }).pipe(
    Effect.catchAllCause(cause => Effect.zipRight(Effect.logError('Job claimer failed', cause), Effect.sleep(pollMs))),
    Effect.forever,
  );
  const sweeper = Effect.repeat(Effect.catchAllCause(Effect.zipRight(sweepJobs, sweepLapsedListeners), cause => Effect.logError('Worker sweeper failed', cause)), Schedule.spaced(pollMs));
  return Effect.all([sweeper, ...Array.from({ length: concurrency }, () => claimer)], { concurrency: 'unbounded', discard: true }).pipe(
    Effect.zipRight(Effect.never),
  );
};
