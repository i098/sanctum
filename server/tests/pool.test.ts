/** Bounded MySQL pool at capacity: connection bound, queue-limit refusal, waiter cancellation, release and reuse. */
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Redacted, Ref } from 'effect';
import type { RowDataPacket } from 'mysql2';
import { createConnection } from 'mysql2/promise';
import { dbLayer } from '../src/db.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';

const POOL = 2;

/** A pool of `POOL` connections and one queue place, over a database this test owns. */
const withSmallPool = <A, E>(use: (database: TestDatabase) => Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.acquireUseRelease(
    Effect.promise(createTestDatabase),
    database => Effect.provide(use(database), dbLayer({ ...database.mysql, maxConnections: POOL, queueLimit: 1 })),
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

        // Cancellation of a queued transaction finishes only once the pool has a connection to hand over (acquisition is uninterruptible).
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
});
