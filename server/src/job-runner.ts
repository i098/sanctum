/**
 * Worker side of the job ledger: a claim is one `UPDATE ... RETURNING` statement that picks the
 * oldest due row and writes lease token, generation and attempt, so two claimers never take one
 * job; handlers run outside any transaction while the lease is renewed; completion only lands if
 * token and generation still match. Handler failures retry with capped backoff.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient, SqlError, SqlSchema } from '@effect/sql';
import { JobFailure, JobId, JobKind, PrincipalId, WorkspaceId } from '@sanctum/contracts';
import { Cause, Effect, Exit, Option, Schedule, Schema } from 'effect';
import { resolveAccess } from './auth.ts';
import { engineeringDefaults } from './config.ts';
import { DbJson, DbSafeInt } from './db.ts';
import type { ClaimedJob, JobHandlers, JobOutcome } from './job-types.ts';
import { later, REQUESTER_REFUSED } from './jobs.ts';
import { sweepLapsedListeners } from './listeners.ts';
import { sweepIdleMeetings } from './meetings.ts';
import { now } from './sql-dialect.ts';

const MAX_BACKOFF_MS = 5 * 60_000;

export interface Lease {
  readonly job: ClaimedJob;
  readonly token: string;
}

const ClaimedRow = Schema.Struct({
  id: JobId,
  workspace_id: WorkspaceId,
  kind: JobKind,
  work_key: Schema.String,
  payload: DbJson(Schema.Unknown),
  requested_by: Schema.NullOr(PrincipalId),
  source_revision: Schema.NullOr(DbSafeInt),
  attempt: DbSafeInt,
  lease_generation: DbSafeInt,
});

/**
 * Claims the oldest due job of `kinds` in one statement; call it outside a transaction, since a
 * transaction cannot return rows from a write. The `(status, available_at)` index keeps the pick to one row.
 */
export const claimJob = (kinds: ReadonlyArray<JobKind>, leaseMs: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const token = randomUUID();
    const job = yield* SqlSchema.findOne({
      Request: Schema.Void,
      Result: ClaimedRow,
      execute: () => sql`UPDATE jobs SET status = 'running', lease_token = ${token}, lease_generation = lease_generation + 1,
          lease_until = ${later(leaseMs)}, attempts = attempts + 1, updated_at = ${now}
        WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND available_at <= ${now} AND kind IN ${sql.in(kinds)} ORDER BY available_at LIMIT 1)
        RETURNING id, workspace_id, kind, work_key, payload, requested_by, source_revision, attempts AS attempt, lease_generation`,
    })(undefined).pipe(Effect.catchTag('ParseError', error => Effect.die(error)));
    return Option.map(job, (claimed): Lease => ({ job: claimed, token }));
  });

const fenced = (sql: SqlClient.SqlClient, lease: Lease) =>
  sql`id = ${lease.job.id} AND status = 'running' AND lease_token = ${lease.token} AND lease_generation = ${lease.job.lease_generation}`;

/** Extends the lease; false once another worker owns the row (or it was completed). */
const renewLease = (lease: Lease, leaseMs: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const renewed = yield* sql`UPDATE jobs SET lease_until = ${later(leaseMs)} WHERE ${fenced(sql, lease)} RETURNING id`;
    return renewed.length === 1;
  });

export type Completion = JobOutcome | { readonly status: 'failed'; readonly error: JobFailure };

/**
 * Generation-fenced completion; false means the lease was lost and nothing was written.
 * SQLite evaluates every assignment against the row as it was, so `rearmed` and `attempts` are read before being reset.
 */
export const completeJob = (lease: Lease, completion: Completion) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const release = sql`lease_token = NULL, lease_until = NULL, updated_at = ${now}`;
    const update = (() => {
      switch (completion.status) {
        case 'succeeded':
          return sql`UPDATE jobs SET status = iif(rearmed, 'pending', 'succeeded'), attempts = iif(rearmed, 0, attempts), rearmed = 0,
            result = ${JSON.stringify(completion.result ?? null)}, last_error = NULL, ${release} WHERE ${fenced(sql, lease)} RETURNING id`;
        case 'paused':
          // A budget or rate-limit pause does not consume an attempt; the resumed run uses the latest payload.
          return sql`UPDATE jobs SET status = 'paused', attempts = attempts - 1, rearmed = 0, available_at = ${later(completion.resume_after_ms)},
            last_error = ${JSON.stringify({ message: completion.reason, retryable: true })}, ${release} WHERE ${fenced(sql, lease)} RETURNING id`;
        case 'failed': {
          const backoff = Math.min(1000 * 2 ** (lease.job.attempt - 1), MAX_BACKOFF_MS);
          return sql`UPDATE jobs SET
            status = iif(rearmed OR (${completion.error.retryable ? 1 : 0} AND attempts < max_attempts), 'pending', 'failed'),
            available_at = iif(rearmed, available_at, ${later(backoff)}), attempts = iif(rearmed, 0, attempts), rearmed = 0,
            last_error = ${JSON.stringify({ message: completion.error.message, retryable: completion.error.retryable })}, ${release}
            WHERE ${fenced(sql, lease)} RETURNING id`;
        }
      }
    })();
    return (yield* update).length === 1;
  });

/** Resumes due paused jobs and returns expired leases to the queue (or fails them when exhausted). */
export const sweepJobs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE jobs SET status = 'pending', updated_at = ${now} WHERE status = 'paused' AND available_at <= ${now}`;
  yield* sql`UPDATE jobs SET
      status = iif(attempts >= max_attempts AND NOT rearmed, 'failed', 'pending'), attempts = iif(rearmed, 0, attempts), rearmed = 0,
      last_error = ${JSON.stringify({ message: 'Lease expired before completion', retryable: true })},
      lease_until = NULL, lease_token = NULL, updated_at = ${now}
    WHERE status = 'running' AND lease_until <= ${now}`;
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
  const sweep = Effect.all([sweepJobs, sweepLapsedListeners, sweepIdleMeetings()], { discard: true });
  const sweeper = Effect.repeat(Effect.catchAllCause(sweep, cause => Effect.logError('Worker sweeper failed', cause)), Schedule.spaced(pollMs));
  return Effect.all([sweeper, ...Array.from({ length: concurrency }, () => claimer)], { concurrency: 'unbounded', discard: true }).pipe(
    Effect.zipRight(Effect.never),
  );
};
