import { SqlClient, SqlError } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { JobFailure, type JobKind, type PrincipalId, type WorkspaceId } from '@sanctum/contracts';
import { Effect, Fiber, Option, Ref, Schedule } from 'effect';
import { createAgent } from '../src/agents.ts';
import { resolveAccess } from '../src/auth.ts';
import type { ClaimedJob, JobHandlers } from '../src/job-handlers.ts';
import { claimJob, completeJob, enqueueJob, type Lease, retryDeadlocks, runWorker, sweepJobs } from '../src/jobs.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

const migrated = { migrated: true };
const KINDS: ReadonlyArray<JobKind> = ['context.refresh'];
const LEASE_MS = 30_000;

interface Row {
  id: string;
  status: string;
  attempts: number;
  rearmed: number;
  payload: unknown;
  due: number;
  last_error: { message: string } | null;
}

const row = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [found] = yield* sql<Row>`SELECT id, status, attempts, rearmed, payload, available_at <= UTC_TIMESTAMP(6) AS due, last_error FROM jobs WHERE id = ${id}`;
    return { ...found!, due: Number(found!.due) };
  });

const claim = Effect.map(claimJob(KINDS, LEASE_MS), Option.getOrThrow);
const makeDue = (id: string) => Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE jobs SET available_at = UTC_TIMESTAMP(6) WHERE id = ${id}`);
const fail = (lease: Lease, retryable: boolean) => completeJob(lease, { status: 'failed', error: new JobFailure({ message: 'provider timeout', retryable }) });

const seed = Effect.map(seedWorkspace('Jobs', ['owner']), ([owner]) => owner!);
const job = (workspace_id: WorkspaceId, work_key: string, payload: unknown = {}, extra: { requested_by?: PrincipalId; max_attempts?: number; delay_ms?: number } = {}) =>
  enqueueJob({ workspace_id, kind: 'context.refresh', work_key, payload, requested_by: extra.requested_by ?? null, ...extra });

/** Polls the ledger until `predicate` holds for the row (worker tests run on real time). */
const until = (id: string, predicate: (row: Row) => boolean) =>
  row(id).pipe(
    Effect.filterOrFail(predicate, () => 'not yet'),
    Effect.retry(Schedule.spaced('50 millis')),
    Effect.timeout('10 seconds'),
  );

describe('job ledger', () => {
  it.effect('coalesces active work keys per workspace and keeps finished history', () =>
    withDatabase(
      Effect.gen(function* () {
        const owner = yield* seed;
        const [other] = yield* seedWorkspace('Jobs', ['owner']);
        const first = yield* job(owner.workspace_id, 'meeting:1', { turns: 1 }, { delay_ms: 60_000 });
        const again = yield* job(owner.workspace_id, 'meeting:1', { turns: 2 });
        expect(again).toBe(first);
        expect(yield* row(first)).toMatchObject({ status: 'pending', payload: { turns: 2 }, due: 0 });
        yield* makeDue(first);
        const lease = yield* claim;
        expect(lease.job).toMatchObject({ id: first, attempt: 1, payload: { turns: 2 } });
        expect(yield* completeJob(lease, { status: 'succeeded', result: { ok: true } })).toBe(true);
        const next = yield* job(owner.workspace_id, 'meeting:1', { turns: 3 });
        expect(next).not.toBe(first);
        expect(yield* row(first)).toMatchObject({ status: 'succeeded' });
        // Keys are per workspace and compared byte-for-byte.
        expect(yield* job(other!.workspace_id, 'meeting:1')).not.toBe(next);
        expect(yield* job(owner.workspace_id, 'Meeting:1')).not.toBe(next);
      }),
      migrated,
    ),
  );

  it.effect('claims each due job exactly once across concurrent workers through the claim index', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const owner = yield* seed;
        yield* Effect.forEach(Array.from({ length: 12 }, (_, index) => index), index => job(owner.workspace_id, `k${index}`));
        const later = yield* job(owner.workspace_id, 'later', {}, { delay_ms: 60_000 });
        const claimed = yield* Ref.make<ReadonlyArray<string>>([]);
        const worker = Effect.gen(function* () {
          for (; ;) {
            const lease = yield* claimJob(KINDS, LEASE_MS);
            if (Option.isNone(lease)) return;
            yield* Ref.update(claimed, ids => [...ids, lease.value.job.id]);
          }
        });
        yield* Effect.all([worker, worker, worker, worker], { concurrency: 'unbounded' });
        const ids = yield* Ref.get(claimed);
        expect(ids).toHaveLength(12);
        expect(new Set(ids).size).toBe(12);
        expect(ids).not.toContain(later);
        expect(Option.isNone(yield* claimJob(KINDS, LEASE_MS))).toBe(true);

        const plan = yield* sql<{ key: string | null }>`EXPLAIN SELECT id FROM jobs
          WHERE status = 'pending' AND available_at <= UTC_TIMESTAMP(6) AND kind IN ('context.refresh')
          ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
        expect(plan[0]!.key).toBe('jobs_claim_idx');
      }),
      migrated,
    ),
  );

  it.effect('fences completion by lease token and generation after an expired lease is reclaimed', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const owner = yield* seed;
        const id = yield* job(owner.workspace_id, 'meeting:1');
        const stale = yield* claim;
        yield* sql`UPDATE jobs SET lease_until = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ${id}`;
        yield* sweepJobs;
        expect(yield* row(id)).toMatchObject({ status: 'pending', attempts: 1, last_error: { message: 'Lease expired before completion' } });
        const current = yield* claim;
        expect(current.job.lease_generation).toBe(stale.job.lease_generation + 1);
        expect(yield* completeJob(stale, { status: 'succeeded', result: 'late' })).toBe(false);
        expect(yield* row(id)).toMatchObject({ status: 'running', attempts: 2 });
        expect(yield* completeJob(current, { status: 'succeeded', result: 'fresh' })).toBe(true);
        expect(yield* completeJob(current, { status: 'succeeded', result: 'twice' })).toBe(false);
        const [{ result }] = (yield* sql<{ result: unknown }>`SELECT result FROM jobs WHERE id = ${id}`) as [{ result: unknown }];
        expect(result).toBe('fresh');

        // An exhausted job whose lease expires fails instead of looping forever.
        const exhausted = yield* job(owner.workspace_id, 'meeting:2', {}, { max_attempts: 1 });
        yield* claim;
        yield* sql`UPDATE jobs SET lease_until = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ${exhausted}`;
        yield* sweepJobs;
        expect(yield* row(exhausted)).toMatchObject({ status: 'failed', attempts: 1 });
      }),
      migrated,
    ),
  );

  it.effect('retries retryable failures with backoff up to max_attempts and fails others at once', () =>
    withDatabase(
      Effect.gen(function* () {
        const owner = yield* seed;
        const id = yield* job(owner.workspace_id, 'meeting:1', {}, { max_attempts: 2 });
        expect(yield* fail(yield* claim, true)).toBe(true);
        expect(yield* row(id)).toMatchObject({ status: 'pending', attempts: 1, due: 0, last_error: { message: 'provider timeout' } });
        expect(Option.isNone(yield* claimJob(KINDS, LEASE_MS))).toBe(true);
        yield* makeDue(id);
        expect(yield* fail(yield* claim, true)).toBe(true);
        expect(yield* row(id)).toMatchObject({ status: 'failed', attempts: 2 });

        const fatal = yield* job(owner.workspace_id, 'meeting:2', {}, { max_attempts: 5 });
        yield* fail(yield* claim, false);
        expect(yield* row(fatal)).toMatchObject({ status: 'failed', attempts: 1 });
      }),
      migrated,
    ),
  );

  it.effect('parks paused jobs without spending an attempt and resumes them', () =>
    withDatabase(
      Effect.gen(function* () {
        const owner = yield* seed;
        const id = yield* job(owner.workspace_id, 'meeting:1');
        yield* completeJob(yield* claim, { status: 'paused', resume_after_ms: 0, reason: 'model budget reached' });
        expect(yield* row(id)).toMatchObject({ status: 'paused', attempts: 0, last_error: { message: 'model budget reached' } });
        expect(Option.isNone(yield* claimJob(KINDS, LEASE_MS))).toBe(true);
        yield* sweepJobs;
        const resumed = yield* claim;
        expect(resumed.job).toMatchObject({ id, attempt: 1 });
      }),
      migrated,
    ),
  );

  it.effect('re-arms a running job so the latest payload runs after the current run', () =>
    withDatabase(
      Effect.gen(function* () {
        const owner = yield* seed;
        const id = yield* job(owner.workspace_id, 'meeting:1', { turns: 1 });
        const running = yield* claim;
        expect(yield* job(owner.workspace_id, 'meeting:1', { turns: 5 })).toBe(id);
        expect(yield* row(id)).toMatchObject({ status: 'running', rearmed: 1 });
        expect(yield* completeJob(running, { status: 'succeeded', result: null })).toBe(true);
        expect(yield* row(id)).toMatchObject({ status: 'pending', rearmed: 0, attempts: 0 });
        const rerun = yield* claim;
        expect(rerun.job).toMatchObject({ id, attempt: 1, payload: { turns: 5 } });
        yield* job(owner.workspace_id, 'meeting:1', { turns: 6 });
        // Even a non-retryable failure of the old run leaves the newer work pending.
        yield* fail(rerun, false);
        expect(yield* row(id)).toMatchObject({ status: 'pending', payload: { turns: 6 } });
      }),
      migrated,
    ),
  );

  it.live('retries deadlocked transactions a bounded number of times and nothing else', () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const failing = (errno: number, failures: number) =>
        Effect.gen(function* () {
          const attempt = yield* Ref.updateAndGet(attempts, count => count + 1);
          if (attempt <= failures) return yield* new SqlError.SqlError({ cause: { errno }, message: 'lock failure' });
          return attempt;
        });
      expect(yield* retryDeadlocks(failing(1213, 2))).toBe(3);
      yield* Ref.set(attempts, 0);
      expect((yield* Effect.flip(retryDeadlocks(failing(1213, 99)))).message).toBe('lock failure');
      expect(yield* Ref.get(attempts)).toBe(5);
      yield* Ref.set(attempts, 0);
      yield* Effect.flip(retryDeadlocks(failing(1062, 99)));
      expect(yield* Ref.get(attempts)).toBe(1);
    }),
  );

  it.live('runs handlers, renews leases, re-checks requesters and records defects', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const owner = yield* seed;
        const admin = yield* resolveAccess({ workspace_id: owner.workspace_id, principal_id: owner.principal.id });
        const agent = yield* createAgent(admin, { display_name: 'Bot', scopes: ['context:read'], meetings: { kind: 'accessible' }, expires_at: null });
        const runs = yield* Ref.make<ReadonlyArray<string>>([]);
        const handlers: JobHandlers<SqlClient.SqlClient> = {
          'context.refresh': (claimed: ClaimedJob) =>
            Effect.gen(function* () {
              yield* Ref.update(runs, list => [...list, claimed.work_key]);
              if (claimed.work_key === 'slow') yield* Effect.sleep('900 millis');
              if (claimed.work_key === 'defect') return yield* Effect.die(new Error('handler bug'));
              return { status: 'succeeded' as const, result: { key: claimed.work_key } };
            }),
        };
        const worker = yield* Effect.fork(runWorker(handlers, { leaseMs: 300, pollMs: 50, concurrency: 2 }));

        const slow = yield* job(owner.workspace_id, 'slow', {}, { requested_by: owner.principal.id });
        const defect = yield* job(owner.workspace_id, 'defect');
        const byAgent = yield* job(owner.workspace_id, 'agent-work', {}, { requested_by: agent.agent.id });
        yield* sql`UPDATE agent_credentials SET revoked_at = UTC_TIMESTAMP(6) WHERE principal_id = ${agent.agent.id}`;

        expect(yield* until(slow, current => current.status === 'succeeded')).toMatchObject({ attempts: 1 });
        expect(yield* until(defect, current => current.status === 'failed')).toMatchObject({ attempts: 1 });
        expect((yield* row(defect)).last_error!.message).toContain('handler bug');
        const denied = yield* until(byAgent, current => current.status === 'failed');
        expect(denied.last_error).toEqual({ message: 'Requester is no longer authorized', retryable: false });
        expect([...(yield* Ref.get(runs))].sort()).toEqual(['defect', 'slow']);
        yield* Fiber.interrupt(worker);
      }),
      migrated,
    ),
  );

  it.live('stops a handler whose lease was taken over and writes nothing for it', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const owner = yield* seed;
        const interrupted = yield* Ref.make(false);
        const handlers: JobHandlers<SqlClient.SqlClient> = {
          'context.refresh': () =>
            Effect.never.pipe(
              Effect.onInterrupt(() => Ref.set(interrupted, true)),
              Effect.as({ status: 'succeeded' as const, result: null }),
            ),
        };
        const worker = yield* Effect.fork(runWorker(handlers, { leaseMs: 300, pollMs: 50, concurrency: 1 }));
        const id = yield* job(owner.workspace_id, 'meeting:1');
        yield* until(id, current => current.status === 'running');
        yield* sql`UPDATE jobs SET lease_token = 'another-worker', lease_generation = lease_generation + 1 WHERE id = ${id}`;
        yield* Ref.get(interrupted).pipe(Effect.repeat({ schedule: Schedule.spaced('50 millis'), until: done => done }), Effect.timeout('5 seconds'));
        yield* Fiber.interrupt(worker);
        const [lease] = yield* sql<{ status: string; lease_token: string }>`SELECT status, lease_token FROM jobs WHERE id = ${id}`;
        expect(lease).toEqual({ status: 'running', lease_token: 'another-worker' });
      }),
      migrated,
    ),
  );
});
