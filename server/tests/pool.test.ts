/** Bounded MySQL pool at capacity: connection bound, queue-limit refusal, waiter cancellation, release and reuse. */
import { tracingChannel } from 'node:diagnostics_channel';
import { HttpServer } from '@effect/platform';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import type { AccessScope } from '@sanctum/contracts';
import { Context, Deferred, Effect, Exit, Fiber, FiberId, Layer, Redacted, Ref, Tracer } from 'effect';
import type { RowDataPacket } from 'mysql2';
import { createConnection } from 'mysql2/promise';
import { Authenticator } from '../src/auth.ts';
import { dbLayer } from '../src/db.ts';
import { serverLayer } from '../src/main.ts';
import { loadMigrations, migrate } from '../src/migrate.ts';
import { createTestDatabase, runSql, type TestDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

const POOL = 2;

/** A pool of `POOL` connections and `queueLimit` queue places (0 is unbounded), over a database this test owns. */
const withSmallPool = <A, E>(use: (database: TestDatabase) => Effect.Effect<A, E, SqlClient.SqlClient>, queueLimit = 1) =>
  Effect.acquireUseRelease(
    Effect.promise(createTestDatabase),
    database => Effect.provide(use(database), dbLayer({ ...database.mysql, maxConnections: POOL, queueLimit })),
    database => Effect.promise(database.drop),
  );

/** Holds one pooled connection inside a transaction until `release` is signalled; resolves once the connection is held. */
const hold = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const acquired = yield* Deferred.make<number>();
  const release = yield* Deferred.make<void>();
  const fiber = yield* Effect.fork(sql.withTransaction(Effect.gen(function* () {
    const [row] = yield* sql<{ id: string }>`SELECT CONNECTION_ID() AS id`;
    yield* Deferred.succeed(acquired, Number(row!.id));
    yield* Deferred.await(release);
  })));
  return { id: yield* Deferred.await(acquired), release: Deferred.succeed(release, undefined), done: Fiber.join(fiber) };
});

const holdAll = Effect.all(Array.from({ length: POOL }, () => hold));

/** Connections this account holds on the test database, counted from a connection that is not in the pool. */
const connectionsOn = (database: TestDatabase) =>
  Effect.promise(async () => {
    const { host, port, username, password } = database.mysql;
    const observer = await createConnection({ host, port, user: username, password: Redacted.value(password) });
    try {
      const [rows] = await observer.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM information_schema.processlist WHERE db = ?', [database.name]);
      return Number(rows[0]!.total);
    } finally {
      await observer.end();
    }
  });

/** Starts a transaction waiter on the saturated pool and returns once the pool has queued it, proven by the queue limit refusing the next one. */
const queueWaiter = <A, E>(work: Effect.Effect<A, E, never>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const waiter = yield* Effect.fork(sql.withTransaction(work));
    yield* Effect.repeat(Effect.yieldNow().pipe(Effect.zipRight(waiter.status)), { until: status => status._tag === 'Suspended' });
    const refused = yield* Effect.flip(sql.withTransaction(Effect.void));
    expect(String(refused.cause)).toMatch(/Queue limit reached/);
    return waiter;
  });

/** If a connection leaked, fewer than `POOL` holders could ever acquire one and this would not complete. */
const poolIsWhole = Effect.gen(function* () {
  const holders = yield* holdAll;
  expect(new Set(holders.map(holder => holder.id)).size).toBe(POOL);
  yield* Effect.all(holders.map(holder => holder.release));
  yield* Effect.all(holders.map(holder => holder.done));
});

describe('bounded connection pool', () => {
  it.effect('opens at most the configured connections, refuses past the queue limit and serves the waiter once a connection is released', () =>
    withSmallPool(database =>
      Effect.gen(function* () {
        const holders = yield* holdAll;
        expect(new Set(holders.map(holder => holder.id)).size).toBe(POOL);
        const waiter = yield* queueWaiter(Effect.sync(() => 'served'));
        expect(yield* connectionsOn(database)).toBe(POOL);

        yield* holders[0]!.release;
        expect(yield* Fiber.join(waiter)).toBe('served');
        yield* Effect.all(holders.map(holder => holder.release));
        yield* Effect.all(holders.map(holder => holder.done));

        yield* poolIsWhole;
        expect(yield* connectionsOn(database)).toBeLessThanOrEqual(POOL);
        const [row] = yield* (yield* SqlClient.SqlClient)<{ ok: number }>`SELECT 1 AS ok`;
        expect(Number(row?.ok)).toBe(1);
      }),
    ),
  );

  it.effect('cancelling a queued waiter runs none of its work and leaks no connection', () =>
    withSmallPool(database =>
      Effect.gen(function* () {
        const holders = yield* holdAll;
        const ran = yield* Ref.make(false);
        const waiter = yield* queueWaiter(Ref.set(ran, true));

        // @effect/sql acquires a transaction's connection uninterruptibly, so cancelling the waiter finishes once a slot frees.
        const cancel = yield* Effect.fork(Fiber.interrupt(waiter));
        yield* holders[0]!.release;
        const exit = yield* Fiber.join(cancel);
        expect(Exit.isInterrupted(exit)).toBe(true);
        expect(yield* Ref.get(ran)).toBe(false);

        yield* Effect.all(holders.map(holder => holder.release));
        yield* Effect.all(holders.map(holder => holder.done));
        yield* poolIsWhole;
        expect(yield* connectionsOn(database)).toBeLessThanOrEqual(POOL);
      }),
    ),
  );

  it.effect('queues every waiter without refusal when the queue limit is 0', () =>
    withSmallPool(database =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const holders = yield* holdAll;
        const waiters = yield* Effect.all(Array.from({ length: 3 }, (_, n) => Effect.fork(Effect.map(sql<{ n: number }>`SELECT ${n} AS n`, ([row]) => Number(row!.n)))));
        // A refused waiter is done at once; holders are released before any assertion so a failure cannot block teardown.
        const queued = yield* Effect.repeat(Effect.yieldNow().pipe(Effect.zipRight(Effect.all(waiters.map(waiter => waiter.status)))), {
          until: statuses => statuses.every(status => status._tag !== 'Running'),
        });
        const open = yield* connectionsOn(database);
        yield* Effect.all(holders.map(holder => holder.release));
        yield* Effect.all(holders.map(holder => holder.done));

        expect(queued.map(status => status._tag)).toEqual(['Suspended', 'Suspended', 'Suspended']);
        expect(open).toBe(POOL);
        expect(yield* Effect.all(waiters.map(Fiber.join))).toEqual([0, 1, 2]);
        yield* poolIsWhole;
      }),
    0),
  );
});

/**
 * The real API on a two-connection pool over a disposable database. A test-owned transaction holds the workspace row lock, so
 * a request that is dispatched blocks inside MySQL and keeps its pooled connection, which lets two requests saturate the pool.
 * `mysql2` diagnostics channels (public API) report when a request asks the pool for a connection and when its SQL is dispatched.
 */
const serveRenames = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
  yield* Effect.provide(migrate(loadMigrations()), dbLayer(database.mysql));
  const [owner] = yield* Effect.promise(() => runSql(database, seedWorkspace('Pool', ['owner'])));

  // `x-label` names a request; the entry settles with the exit of that request's server fiber.
  const ended = new Map<string, Deferred.Deferred<Exit.Exit<unknown, unknown>>>();
  const endOf = (label: string) => {
    const entry = ended.get(label) ?? Deferred.unsafeMake<Exit.Exit<unknown, unknown>>(FiberId.none);
    ended.set(label, entry);
    return entry;
  };
  const fibers = new Map<string, Fiber.RuntimeFiber<unknown, unknown>>();
  const authenticator = Layer.succeed(Authenticator, {
    authenticate: request =>
      Effect.withFiberRuntime<AccessScope, never>(fiber => {
        const label = request.headers['x-label'] ?? '';
        fibers.set(label, fiber);
        return Effect.as(Effect.forkDaemon(Effect.flatMap(Fiber.await(fiber), exit => Deferred.succeed(endOf(label), exit))), owner!);
      }),
  });
  const waiting: Array<() => void> = [];
  const changed = () => waiting.slice().forEach(check => check());
  // Each SQL statement opens one `sql.execute` span before it asks for a connection.
  let statements = 0;
  const defaultTracer = yield* Effect.tracer;
  const counting = Layer.setTracer(
    Tracer.make({
      span: (name, ...rest) => {
        if (name === 'sql.execute') {
          statements++;
          changed();
        }
        return defaultTracer.span(name, ...rest);
      },
      context: defaultTracer.context,
    }),
  );
  const context = yield* Layer.build(
    serverLayer({ apiPort: 0, mysql: { ...database.mysql, maxConnections: POOL, queueLimit: 10 } }, authenticator).pipe(Layer.provide(counting)),
  );
  statements = 0; // the server's own start-up statements are not requests
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (address._tag !== 'TcpAddress') throw new Error('expected TCP');

  const dispatched: Array<string> = [];
  const finished: Array<string> = [];
  const rename = (list: Array<string>) => (message: { query?: string; values?: ReadonlyArray<unknown>; database?: string }) => {
    if (message.database === database.name && message.query?.startsWith('UPDATE workspaces SET name')) list.push(String(message.values?.[0]));
    changed();
  };
  const channels = [
    ['mysql2:execute', 'start', rename(dispatched)],
    ['mysql2:execute', 'asyncEnd', rename(finished)],
  ] as const;
  yield* Effect.acquireRelease(
    Effect.sync(() => channels.forEach(([name, event, handler]) => tracingChannel(name)[event].subscribe(handler as never))),
    () => Effect.sync(() => channels.forEach(([name, event, handler]) => tracingChannel(name)[event].unsubscribe(handler as never))),
  );
  /** Resolves when `condition` holds, re-checked after every pool or SQL event. */
  const until = (condition: () => boolean) =>
    Effect.async<void>(resume => {
      const check = () => {
        if (!condition()) return;
        waiting.splice(waiting.indexOf(check), 1);
        resume(Effect.void);
      };
      waiting.push(check);
      check();
    });

  const { host, port, username, password } = database.mysql;
  const lock = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const connection = await createConnection({ host, port, user: username, password: Redacted.value(password), database: database.name });
      await connection.query('SET autocommit = 0');
      await connection.query('SELECT id FROM workspaces WHERE id = ? FOR UPDATE', [owner!.workspace_id]);
      return connection;
    }),
    connection => Effect.promise(() => connection.end()),
  );
  const workspaceName = Effect.promise(async () => {
    const [rows] = await lock.query<RowDataPacket[]>('SELECT name FROM workspaces WHERE id = ?', [owner!.workspace_id]);
    return String(rows[0]!.name);
  });
  const post = (label: string, name: string, signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${address.port}/api/v1/workspace/name`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-label': label },
      body: JSON.stringify({ name }),
      signal: signal ?? null,
    });
  /** The request's fiber has begun its statement and is suspended again: the next thing it waits for is a connection. */
  const waitingForConnection = (label: string, statementNumber: number) =>
    Effect.zipRight(
      until(() => statements >= statementNumber),
      Effect.repeat(Effect.yieldNow().pipe(Effect.zipRight(Effect.suspend(() => fibers.get(label)!.status))), { until: status => status._tag === 'Suspended' }),
    );
  return { dispatched, finished, until, waitingForConnection, endOf, post, workspaceName, unlock: Effect.promise(() => lock.commit()) };
});

describe('cancelled requests on a saturated pool', () => {
  it.scoped('a request cancelled while waiting for a connection never dispatches its write', () =>
    Effect.gen(function* () {
      const server = yield* serveRenames;
      const first = server.post('first', 'first');
      const second = server.post('second', 'second');
      // Both statements are inside MySQL, blocked on the row lock, holding both pooled connections.
      yield* server.until(() => server.dispatched.length === 2);

      const abort = new AbortController();
      const queued = server.post('queued', 'queued', abort.signal).catch(error => error);
      yield* server.waitingForConnection('queued', 3);
      abort.abort();
      expect(yield* Effect.promise(() => queued)).toMatchObject({ name: 'AbortError' });
      expect(Exit.isInterrupted(yield* Deferred.await(server.endOf('queued')))).toBe(true);

      yield* server.unlock;
      expect((yield* Effect.promise(() => first)).status).toBe(200);
      expect((yield* Effect.promise(() => second)).status).toBe(200);
      // The pool queue is first-in first-out: once this later write is dispatched, anything cancelled before it has had its chance to run.
      expect((yield* Effect.promise(() => server.post('after', 'after'))).status).toBe(200);
      expect([...server.dispatched].sort()).toEqual(['after', 'first', 'second']);
      expect(yield* server.workspaceName).toBe('after');
    }),
  );

  it.scoped('a request cancelled after its write was dispatched does not roll the write back', () =>
    Effect.gen(function* () {
      const server = yield* serveRenames;
      const abort = new AbortController();
      const sent = server.post('sent', 'kept', abort.signal).catch(error => error);
      yield* server.until(() => server.dispatched.length === 1);
      abort.abort();
      expect(yield* Effect.promise(() => sent)).toMatchObject({ name: 'AbortError' });
      expect(Exit.isInterrupted(yield* Deferred.await(server.endOf('sent')))).toBe(true);

      yield* server.unlock;
      yield* server.until(() => server.finished.length === 1);
      expect(yield* server.workspaceName).toBe('kept');
    }),
  );
});
