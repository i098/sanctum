/**
 * Background work runs from the durable ledger, independent of API processes and sockets:
 * kill the API or a worker at any point and accepted work still finishes exactly once, or
 * truthfully becomes `unknown` when a submission may have reached the provider.
 */
import { HttpServer } from '@effect/platform';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, type ActionId, Unauthenticated } from '@sanctum/contracts';
import { Context, Effect, Exit, Fiber, Layer, Schedule, Scope } from 'effect';
import { beforeEach, vi } from 'vitest';
import { createActionGrant, requestAction } from '../src/actions.ts';
import { Authenticator } from '../src/auth.ts';
import { engineeringDefaults } from '../src/config.ts';
import { dbLayer } from '../src/db.ts';
import { executeAction } from '../src/executor.ts';
import { runWorker } from '../src/job-runner.ts';
import { serverLayer } from '../src/main.ts';
import { loadMigrations, migrate } from '../src/migrate.ts';
import { actionRow, actionServices, provider, seedAccount, seedCredential } from './support/actions.ts';
import { createTestDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

vi.mock('../src/integrations.ts', async importOriginal => {
  const { fakeIntegrations } = await import('./support/actions.ts');
  return fakeIntegrations(importOriginal as never);
});

beforeEach(() => provider.reset());

const SEND = 'gmail-send-email';

/** Migrated disposable database; `mysql` lets tests start API servers against it. */
const database = Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop)).pipe(
  Effect.tap(db => Effect.provide(migrate(loadMigrations()), dbLayer(db.mysql))),
);

const seed = Effect.gen(function* () {
  const [owner, agent] = yield* seedWorkspace('Recovery', ['owner', 'agent']);
  yield* seedCredential(owner!, agent!);
  const account = yield* seedAccount(owner!);
  yield* createActionGrant(owner!, { grantee: agent!.principal.id, action_key: SEND, account_id: account, meeting_id: null, restrictions: {}, expires_at: null });
  return { owner: owner!, agent: agent! };
});

const send = (agent: AccessScope, key: string) =>
  requestAction(agent, { action_key: SEND, configuration_ref: 'cfg', version: '1', arguments: { to: `${key}@example.com` }, meeting_id: null, idempotency_key: key });

/** Polls until `check` yields a value; the worker loop runs on the live clock. */
const eventually = <A, E, R>(check: Effect.Effect<A | undefined, E, R>) =>
  check.pipe(
    Effect.flatMap(value => (value === undefined ? Effect.fail('pending' as const) : Effect.succeed(value))),
    Effect.retry({ schedule: Schedule.spaced('100 millis'), times: 200 }),
  );

const whenState = (agent: AccessScope, id: ActionId, state: string) =>
  eventually(Effect.map(actionRow(agent.workspace_id, id), row => (row.state === state ? row : undefined)));

const jobFor = (id: ActionId) =>
  Effect.flatMap(SqlClient.SqlClient, sql => sql<{ status: string; attempts: number; lease_generation: string }>`
    SELECT status, attempts, lease_generation FROM jobs WHERE kind = 'action.execute' AND work_key = ${id}`).pipe(Effect.map(rows => rows[0]!));

const expireLeases = Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE jobs SET lease_until = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE status = 'running'`);

/** Only the handler these tests exercise, so the worker needs no media or model providers. */
const worker = Effect.fork(runWorker({ 'action.execute': executeAction }).pipe(Effect.provide(actionServices)));

describe('worker recovery', () => {
  it.live('finishes work accepted over HTTP after the API process is gone', () =>
    Effect.gen(function* () {
      const db = yield* database;
      const { owner, agent } = yield* Effect.provide(seed, dbLayer(db.mysql));
      const auth = Layer.succeed(Authenticator, {
        authenticate: request =>
          request.headers.authorization === 'Bearer agent' ? Effect.succeed(agent)
          : request.headers.authorization === 'Bearer owner' ? Effect.succeed(owner)
          : Effect.fail(new Unauthenticated({ message: 'no credentials' })),
      });
      const api = Effect.gen(function* () {
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(serverLayer({ apiPort: 0, mysql: db.mysql }, auth), scope);
        const address = Context.get(context, HttpServer.HttpServer).address;
        return { base: address._tag === 'TcpAddress' ? `http://127.0.0.1:${address.port}` : '', close: Scope.close(scope, Exit.void) };
      });
      const call = (base: string, token: string, path: string, body?: unknown) =>
        Effect.promise(async () => {
          const response = await fetch(`${base}/api/v1${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          return { status: response.status, body: (await response.json()) as Record<string, unknown> };
        });

      const first = yield* api;
      const accepted = yield* call(first.base, 'agent', '/actions', {
        action_key: SEND, configuration_ref: 'cfg', version: '1', arguments: { to: 'a@example.com' }, meeting_id: null, idempotency_key: 'http-1',
      });
      expect(accepted).toMatchObject({ status: 202, body: { state: 'queued' } });
      yield* first.close; // API killed before any worker ran.

      const action_id = accepted.body.action_id as ActionId;
      yield* Effect.provide(Effect.zipRight(worker, whenState(agent, action_id, 'succeeded')), dbLayer(db.mysql));

      const second = yield* api;
      expect(yield* call(second.base, 'agent', `/actions/${action_id}`)).toMatchObject({ status: 200, body: { state: 'succeeded', attempts: 1 } });
      expect((yield* call(second.base, 'agent', `/actions/${action_id}/resolve`, { outcome: 'failed', provider_receipt: null })).status).toBe(403);
      yield* second.close;
      expect(provider.sent).toHaveLength(1);
    }).pipe(Effect.scoped));

  it.live('lets concurrent workers claim every job exactly once', () =>
    Effect.gen(function* () {
      const db = yield* database;
      yield* Effect.gen(function* () {
        const { agent } = yield* seed;
        const queued = yield* Effect.forEach(Array.from({ length: 12 }, (_, index) => `bulk-${index}`), key => send(agent, key));
        yield* Effect.all([worker, worker, worker]);
        yield* Effect.forEach(queued, ({ action_id }) => whenState(agent, action_id, 'succeeded'));
        expect(new Set(provider.sent.map(input => input.provider_idempotency_key)).size).toBe(12);
        expect(provider.sent).toHaveLength(12);
      }).pipe(Effect.provide(dbLayer(db.mysql)));
    }).pipe(Effect.scoped));

  it.live('recovers a stale lease as unknown and keeps the late completion of the original attempt', () =>
    Effect.gen(function* () {
      const db = yield* database;
      yield* Effect.gen(function* () {
        const { agent } = yield* seed;
        provider.mode = 'hold';
        const { action_id } = yield* send(agent, 'slow');
        yield* worker; // A: submits, then its provider call hangs.
        yield* whenState(agent, action_id, 'running');
        yield* expireLeases;
        yield* worker; // B: reclaims the expired lease.
        expect(yield* whenState(agent, action_id, 'unknown')).toMatchObject({ reconciliation: 'pending', last_error: { code: 'interrupted' } });
        expect(yield* eventually(Effect.map(jobFor(action_id), job => (job.status === 'succeeded' ? job : undefined)))).toMatchObject({ attempts: 2, lease_generation: '2' });

        provider.release!(); // A's upstream answer finally arrives.
        expect(yield* whenState(agent, action_id, 'succeeded')).toMatchObject({ reconciliation: 'reconciled', attempts: 1 });
        expect(provider.sent).toHaveLength(1);
        expect(yield* jobFor(action_id)).toMatchObject({ status: 'succeeded', lease_generation: '2' });
      }).pipe(Effect.provide(dbLayer(db.mysql)));
    }).pipe(Effect.scoped));

  it.live('never resubmits after a worker is killed mid-submission', () =>
    Effect.gen(function* () {
      const db = yield* database;
      yield* Effect.gen(function* () {
        const { agent } = yield* seed;
        provider.mode = 'hold';
        const { action_id } = yield* send(agent, 'killed');
        const killed = yield* worker;
        yield* whenState(agent, action_id, 'running');
        yield* Fiber.interrupt(killed);
        provider.mode = 'ok';
        yield* expireLeases;
        yield* worker;
        expect(yield* whenState(agent, action_id, 'unknown')).toMatchObject({ reconciliation: 'pending', attempts: 1 });
        expect(provider.sent).toHaveLength(1);
      }).pipe(Effect.provide(dbLayer(db.mysql)));
    }).pipe(Effect.scoped));

  it.live('pauses at the action budget and resumes when the window frees up', () =>
    Effect.gen(function* () {
      const db = yield* database;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { agent } = yield* seed;
        const { perWindow, windowMs } = engineeringDefaults.actionBudget;
        // A full window of earlier submissions that age out about two seconds from now.
        for (let index = 0; index < perWindow; index++) {
          yield* sql`
            INSERT INTO actions (id, workspace_id, requested_by, action_key, idempotency_key, args, args_sha256, version, state, attempts, started_at, created_at, updated_at)
            VALUES (UUID(), ${agent.workspace_id}, ${agent.principal.id}, ${SEND}, ${`earlier-${index}`}, '{}', UNHEX(SHA2('x', 256)), '1', 'succeeded', 1,
              UTC_TIMESTAMP(6) - INTERVAL ${(windowMs - 2_000) * 1000} MICROSECOND, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
        }
        const { action_id } = yield* send(agent, 'over-budget');
        yield* worker;
        const paused = yield* eventually(Effect.map(jobFor(action_id), job => (job.status === 'paused' ? job : undefined)));
        expect(paused.attempts).toBe(0);
        expect((yield* actionRow(agent.workspace_id, action_id)).state).toBe('queued');
        expect(provider.sent).toHaveLength(0);
        yield* whenState(agent, action_id, 'succeeded');
        expect(provider.sent).toHaveLength(1);
      }).pipe(Effect.provide(dbLayer(db.mysql)));
    }).pipe(Effect.scoped));
});
