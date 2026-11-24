import { SqlClient, type SqlError, SqlSchema } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Schema } from 'effect';
import type { WorkspaceId } from '@sanctum/contracts';
import { DbBool, DbJson, DbSafeInt, DbSha256, DbUtc, dbLayer, increment, isCheckViolation, isDuplicate, isMissingReference } from '../src/db.ts';
import { d1Backend } from '../src/db-d1.ts';
import { addSeconds, chunked, diffMicros, diffSeconds, now } from '../src/sql-dialect.ts';

const workspace = 'w1' as WorkspaceId;

/** The transaction guard tables plus two small tables; the baseline migration carries the real ones. */
const schema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of [
    "CREATE TABLE tx_clock (id INTEGER PRIMARY KEY CHECK (id = 1), v INTEGER NOT NULL)",
    "INSERT INTO tx_clock VALUES (1, 0)",
    "CREATE TABLE tx_conflict (v INTEGER CONSTRAINT tx_conflict_guard CHECK (v IS NULL))",
    "CREATE TABLE workspaces (id TEXT PRIMARY KEY, context_seq INTEGER NOT NULL DEFAULT 0, permission_revision INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL CHECK (length(name) > 0))",
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), body BLOB, flag INTEGER)",
    "INSERT INTO workspaces (id, name) VALUES ('w1', 'one')",
  ]) yield* sql.unsafe(statement);
});

const withDb = <A, E>(use: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.provide(Effect.zipRight(schema, use), dbLayer({ url: ':memory:' }));
const count = (table: string) => SqlClient.SqlClient.pipe(Effect.flatMap(sql => sql.unsafe<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)), Effect.map(rows => rows[0]!.n));
const failureOf = <A>(effect: Effect.Effect<A, SqlError.SqlError, SqlClient.SqlClient>) => Effect.flip(effect);

describe('column schemas', () => {
  it('round-trip database representations', () => {
    expect(Schema.encodeSync(DbUtc)(Schema.decodeSync(DbUtc)('2026-09-26 17:08:16.000100'))).toBe('2026-09-26 17:08:16.000100');
    expect(() => Schema.decodeUnknownSync(DbUtc)('2026-09-26T17:08:16Z')).toThrow();
    expect(Schema.decodeSync(DbBool)(1)).toBe(true);
    expect(Schema.decodeUnknownSync(DbSafeInt)('-42')).toBe(-42);
    expect(() => Schema.decodeUnknownSync(DbSafeInt)('1.5')).toThrow();
    const hash = 'ab'.repeat(32);
    expect(Schema.decodeSync(DbSha256)(Schema.encodeSync(DbSha256)(hash))).toBe(hash);
    expect(Schema.decodeUnknownSync(DbJson(Schema.Array(Schema.Number)))('[1,2]')).toEqual([1, 2]);
  });
});

describe('transactions', () => {
  it.effect('commit applies buffered writes; reads before the first write see committed rows', () =>
    withDb(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const seen = yield* sql.withTransaction(Effect.gen(function* () {
        const before = yield* count('notes');
        yield* sql`INSERT INTO notes (workspace_id, body, flag) VALUES (${workspace}, ${new Uint8Array([1, 2, 255])}, ${true})`;
        return before;
      }));
      expect(seen).toBe(0);
      const [row] = yield* sql<{ body: Uint8Array; flag: number }>`SELECT body, flag FROM notes`;
      expect([...row!.body]).toEqual([1, 2, 255]);
      expect(row!.flag).toBe(1);
    })));

  it.effect('a failed body rolls back: nothing is written', () =>
    withDb(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const exit = yield* Effect.exit(sql.withTransaction(Effect.zipRight(sql`INSERT INTO notes (workspace_id) VALUES (${workspace})`, Effect.fail('boom'))));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* count('notes')).toBe(0);
    })));

  it.effect('a failing batch rolls every buffered write back', () =>
    withDb(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* failureOf(sql.withTransaction(Effect.zipRight(sql`INSERT INTO notes (workspace_id) VALUES (${workspace})`, sql`UPDATE workspaces SET name = '' WHERE id = ${workspace}`)));
      expect(isCheckViolation(error)).toBe(true);
      expect(yield* count('notes')).toBe(0);
    })));

  it.effect('reading after a buffered write is an error', () =>
    withDb(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* failureOf(sql.withTransaction(Effect.zipRight(sql`INSERT INTO notes (workspace_id) VALUES (${workspace})`, sql`SELECT * FROM notes`)));
      expect(error.message).toMatch(/Read after a buffered write/);
    })));

  it.live('a transaction that lost the race reruns and commits once', () =>
    withDb(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const started = yield* Deferred.make<void>();
      const rival = yield* Deferred.make<void>();
      let attempts = 0;
      const slow = yield* Effect.fork(sql.withTransaction(Effect.gen(function* () {
        attempts++;
        if (attempts === 1) {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(rival);
        }
        yield* sql`INSERT INTO notes (workspace_id, flag) VALUES (${workspace}, 1)`;
      })));
      yield* Deferred.await(started);
      yield* sql.withTransaction(sql`INSERT INTO notes (workspace_id, flag) VALUES (${workspace}, 2)`);
      yield* Deferred.succeed(rival, undefined);
      yield* Fiber.join(slow);
      expect(attempts).toBe(2);
      expect(yield* count('notes')).toBe(2);
      const [clock] = yield* sql<{ v: number }>`SELECT v FROM tx_clock`;
      expect(clock!.v).toBe(2);
    })));

  it.effect('twenty parallel transactions on one row all commit with distinct numbers', () =>
    withDb(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const numbers = yield* Effect.all(Array.from({ length: 20 }, () => sql.withTransaction(increment('context_seq')(workspace))), { concurrency: 'unbounded' });
      expect(new Set(numbers).size).toBe(20);
      expect(Math.max(...numbers)).toBe(20);
    })));
});

describe('increment', () => {
  it.effect('counts up outside a transaction and twice inside one', () =>
    withDb(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      expect(yield* increment('permission_revision')(workspace)).toBe(1);
      const pair = yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`INSERT INTO notes (workspace_id) VALUES (${workspace})`;
        return [yield* increment('permission_revision')(workspace), yield* increment('permission_revision')(workspace)];
      }));
      expect(pair).toEqual([2, 3]);
      const [row] = yield* sql<{ permission_revision: number }>`SELECT permission_revision FROM workspaces`;
      expect(row!.permission_revision).toBe(3);
    })));
});

describe('errors and dialect', () => {
  it.effect('names duplicate, missing reference and check violations', () =>
    withDb(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      expect(isDuplicate(yield* failureOf(sql`INSERT INTO workspaces (id, name) VALUES ('w1', 'x')`))).toBe(true);
      expect(isMissingReference(yield* failureOf(sql`INSERT INTO notes (workspace_id) VALUES ('nope')`))).toBe(true);
      expect(isCheckViolation(yield* failureOf(sql`UPDATE workspaces SET name = ''`))).toBe(true);
    })));

  it.effect('time helpers and chunking', () =>
    withDb(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{ a: string; b: string; s: number; m: number }>`SELECT ${now} AS a, ${addSeconds("'2026-01-01 00:00:00.000000'", 90.5)} AS b,
        ${diffSeconds("'2026-01-01 00:00:00'", "'2026-01-01 00:01:30.9'")} AS s, ${diffMicros("'2026-01-01 00:00:00'", "'2026-01-01 00:00:01.25'")} AS m`;
      expect(Schema.decodeUnknownSync(DbUtc)(row!.a)).toMatch(/Z$/);
      expect(row!.b).toBe('2026-01-01 00:01:30.500000');
      expect([row!.s, row!.m]).toEqual([90, 1_250_000]);
      expect(chunked(Array.from({ length: 250 }, (_, i) => i), 3).map(chunk => chunk.length)).toEqual([33, 33, 33, 33, 33, 33, 33, 19]);
    })));

  it.effect('FTS5 prefix and hyphenated-word search', () =>
    withDb(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('CREATE VIRTUAL TABLE fts USING fts5(text)');
      yield* sql.unsafe("INSERT INTO fts (text) VALUES ('quarterly well-known budget'), ('other')");
      const find = (query: string) => SqlSchema.findAll({ Request: Schema.String, Result: Schema.Struct({ text: Schema.String }), execute: q => sql`SELECT text FROM fts WHERE fts MATCH ${q} ORDER BY bm25(fts)` })(query);
      expect(yield* find('"budg"*')).toHaveLength(1);
      expect(yield* find('"well-known"')).toHaveLength(1);
    })));
});

describe('D1 backend', () => {
  it.effect('posts statements as JSON with bytes in base64 and decodes the answer', () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; body: unknown }> = [];
      const original = globalThis.fetch;
      globalThis.fetch = (async (url: URL, init: RequestInit) => {
        seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return Response.json(String(url).endsWith('/run') ? { rows: [{ b: { $b: 'AQL/' } }], changes: 0 } : { error: 'D1_ERROR: UNIQUE constraint failed: t.id' }, { status: String(url).endsWith('/run') ? 200 : 400 });
      }) as typeof fetch;
      try {
        const backend = d1Backend('http://d1.internal');
        const result = yield* backend.run({ sql: 'SELECT ?', params: [new Uint8Array([1, 2, 255]), true] });
        expect([...(result.rows[0]!['b'] as Uint8Array)]).toEqual([1, 2, 255]);
        expect(seen[0]).toEqual({ url: 'http://d1.internal/run', body: { sql: 'SELECT ?', params: [{ $b: 'AQL/' }, 1] } });
        const error = yield* Effect.flip(backend.batch([{ sql: 'x', params: [] }]));
        expect(isDuplicate(error)).toBe(true);
      } finally {
        globalThis.fetch = original;
      }
    }));
});
