/**
 * The one database boundary (plan section 07): a SQLite-dialect `SqlClient` over a pluggable
 * backend (`node:sqlite` file or memory, or the D1 gateway), buffered transactions with a commit
 * guard, and column schemas that turn row values into wire-ready values. Domain code decodes
 * rows with `SqlSchema` from `@effect/sql` using these column schemas; nothing else touches raw rows.
 *
 * D1 cannot hold a transaction open between requests, so a transaction reads at once, buffers its
 * writes and commits them in one atomic batch behind a guard on `tx_clock`. A transaction that
 * lost the race is rerun, so its body must not have external side effects.
 */
import * as Reactivity from '@effect/experimental/Reactivity';
import { SqlClient, type SqlConnection, SqlError, Statement } from '@effect/sql';
import { Context, Duration, Effect, Layer, Option, ParseResult, Schedule, Schema, Stream } from 'effect';
import { Sha256Hex, UtcTimestamp, type WorkspaceId } from '@sanctum/contracts';
import { d1Backend } from './db-d1.ts';
import type { DbBackend, DbOptions, DbResult, DbStatement } from './db-types.ts';
import { sqliteBackend } from './db-sqlite.ts';

export type { DbOptions, DbResult } from './db-types.ts';

const fail = (message: string) => new SqlError.SqlError({ cause: new Error(message), message });
const messageOf = (error: SqlError.SqlError) => {
  const cause: unknown = error.cause;
  return cause instanceof Error ? cause.message : String(cause ?? error.message);
};

/** The commit guard failed: another transaction committed after this one began. */
const CONFLICT = /CHECK constraint failed: (tx_conflict_guard|v IS NULL)/;
const isConflict = (error: unknown) => error instanceof SqlError.SqlError && CONFLICT.test(messageOf(error));

export const isDuplicate = (error: SqlError.SqlError) => /UNIQUE constraint failed/.test(messageOf(error));
export const isMissingReference = (error: SqlError.SqlError) => /FOREIGN KEY constraint failed/.test(messageOf(error));
export const isCheckViolation = (error: SqlError.SqlError) => /CHECK constraint failed/.test(messageOf(error)) && !CONFLICT.test(messageOf(error));

/** Statements that return rows run at once; every other statement waits for the commit. */
// shortcut: a keyword inside a string literal can misclassify a WITH statement; upgrade if domain SQL needs that.
const isRead = (sql: string) => {
  const lead = sql.replace(/^(?:\s|\(|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '');
  return /^(select|pragma|explain|values)\b/i.test(lead) || (/^with\b/i.test(lead) && !/\b(insert|update|delete|replace)\b/i.test(lead));
};

const backoff = Schedule.exponential('10 millis').pipe(Schedule.modifyDelay((_, delay) => Duration.min(delay, Duration.millis(200))), Schedule.jittered);

/** A nested transaction joins its parent's buffer; when its body fails, its writes and counters are dropped. */
const rollbackOnError = <A, E, R>(connection: SqlConnection.Connection, effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const state = states.get(connection);
    if (state === undefined) return effect;
    const length = state.buffer.length;
    const counters = new Map(state.counters);
    return Effect.tapErrorCause(effect, () =>
      Effect.sync(() => {
        state.buffer.length = length;
        state.counters.clear();
        for (const [key, value] of counters) state.counters.set(key, value);
      }),
    );
  });

interface TransactionState {
  readonly backend: DbBackend;
  readonly clock: number;
  readonly buffer: DbStatement[];
  /** Counters this transaction already advanced, so a second `increment` reads no buffered write. */
  readonly counters: Map<string, number>;
}
const states = new WeakMap<SqlConnection.Connection, TransactionState>();

const asRows = (result: DbResult, transform: Parameters<SqlConnection.Connection['execute']>[2]) => (transform ? transform(result.rows as Array<object>) : result.rows);

/** Reads go to the backend; writes join the buffer. */
const transactionConnection = (backend: DbBackend, state: TransactionState): SqlConnection.Connection => {
  const execute = (sql: string, params: ReadonlyArray<unknown>): Effect.Effect<DbResult, SqlError.SqlError> => {
    if (!isRead(sql)) {
      if (/\breturning\b/i.test(sql)) return Effect.fail(fail(`RETURNING is not supported in a transaction: ${sql}`));
      state.buffer.push({ sql, params });
      return Effect.succeed({ rows: [], changes: 0 });
    }
    if (state.buffer.length > 0) return Effect.fail(fail(`Read after a buffered write in a transaction: ${sql}`));
    return backend.run({ sql, params });
  };
  return connection(execute);
};

const connection = (execute: (sql: string, params: ReadonlyArray<unknown>) => Effect.Effect<DbResult, SqlError.SqlError>): SqlConnection.Connection => {
  const rows = (sql: string, params: ReadonlyArray<unknown>, transform: Parameters<SqlConnection.Connection['execute']>[2]) => Effect.map(execute(sql, params), result => asRows(result, transform));
  return {
    execute: rows,
    executeUnprepared: rows,
    executeRaw: execute,
    executeValues: (sql, params) => Effect.map(execute(sql, params), result => result.rows.map(row => Object.values(row))),
    executeStream: (sql, params, transform) => Stream.unwrap(Effect.map(rows(sql, params, transform), Stream.fromIterable)),
  };
};

const makeClient = (backend: DbBackend) =>
  Effect.gen(function* () {
    const client = yield* SqlClient.make({
      acquirer: Effect.succeed(connection((sql, params) => backend.run({ sql, params }))),
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [['db.system.name', 'sqlite']],
    });
    const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const [clock] = (yield* backend.run({ sql: 'SELECT v FROM tx_clock WHERE id = 1', params: [] })).rows;
        const state: TransactionState = { backend, clock: Number(clock?.['v']), buffer: [], counters: new Map() };
        const scoped = transactionConnection(backend, state);
        states.set(scoped, state);
        const result = yield* Effect.provideService(effect, SqlClient.TransactionConnection, [scoped, 0] as const);
        if (state.buffer.length > 0) {
          yield* backend.batch([
            { sql: 'INSERT INTO tx_conflict (v) SELECT 1 WHERE (SELECT v FROM tx_clock WHERE id = 1) <> ?', params: [state.clock] },
            { sql: 'UPDATE tx_clock SET v = v + 1 WHERE id = 1', params: [] },
            ...state.buffer,
          ]);
        }
        return result;
      });
    const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError.SqlError, R> =>
      Effect.flatMap(Effect.serviceOption(SqlClient.TransactionConnection), nested =>
        Option.isSome(nested)
          ? rollbackOnError(nested.value[0], effect)
          : Effect.retry(attempt(effect), { schedule: backoff, times: 8, while: isConflict }).pipe(
              Effect.mapError(error => (isConflict(error) ? fail('Transaction conflict: retries exhausted, try again') : error)),
            ),
      );
    return Object.assign(client, { withTransaction });
  }).pipe(Effect.provide(Reactivity.layer));

/** The backend named by `options.url`; API and worker each build their own process-scoped layer. */
export const dbLayer = (options: DbOptions): Layer.Layer<SqlClient.SqlClient, SqlError.SqlError> =>
  Layer.scopedContext(
    Effect.gen(function* () {
      const backend = /^https?:\/\//.test(options.url) ? d1Backend(options.url) : yield* sqliteBackend(options.url);
      return Context.make(SqlClient.SqlClient, yield* makeClient(backend));
    }),
  );

const DB_DATETIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)$/;

/** DATETIME text `2026-09-26 17:08:16.123456` <-> UTC wire timestamp, preserving microseconds. */
export const DbUtc = Schema.transform(Schema.String.pipe(Schema.pattern(DB_DATETIME)), UtcTimestamp, {
  strict: true,
  decode: value => value.replace(DB_DATETIME, '$1T$2Z'),
  encode: value => value.slice(0, -1).replace('T', ' '),
});

/** INTEGER (or its string form) -> exact safe integer; unsafe values fail instead of rounding. */
export const DbSafeInt = Schema.transformOrFail(Schema.Union(Schema.String, Schema.Number), Schema.Number, {
  strict: true,
  decode: (value, _, ast) => {
    const parsed = typeof value === 'number' ? value : /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
    return Number.isSafeInteger(parsed) ? ParseResult.succeed(parsed) : ParseResult.fail(new ParseResult.Type(ast, value, 'not a safe integer'));
  },
  encode: value => ParseResult.succeed(value),
});

/** 0/1 integer -> boolean. */
export const DbBool = Schema.transform(Schema.Literal(0, 1), Schema.Boolean, {
  strict: true,
  decode: value => value === 1,
  encode: value => (value ? 1 : 0),
});

/** JSON column stored as TEXT: rows return JSON text; parameters are sent as JSON text. */
export const DbJson = <A, I>(schema: Schema.Schema<A, I>) => Schema.Union(Schema.parseJson(schema), schema);

/** BLOB SHA-256 <-> lowercase hex. */
export const DbSha256 = Schema.transform(Schema.Uint8ArrayFromSelf, Sha256Hex, {
  strict: true,
  decode: bytes => Buffer.from(bytes).toString('hex'),
  encode: hex => Buffer.from(hex, 'hex'),
});

/**
 * Advances a workspace counter and returns the new value. Outside a transaction one
 * `UPDATE ... RETURNING` does it; inside, the read happens now and the write joins the commit,
 * whose guard makes the read-then-write safe.
 */
export const increment = (column: 'context_seq' | 'permission_revision') => (workspace_id: WorkspaceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const open = yield* Effect.serviceOption(SqlClient.TransactionConnection);
    const state = Option.isSome(open) ? states.get(open.value[0]) : undefined;
    if (state === undefined) {
      const [row] = yield* sql<{ value: unknown }>`UPDATE workspaces SET ${sql(column)} = ${sql(column)} + 1 WHERE id = ${workspace_id} RETURNING ${sql(column)} AS value`;
      if (row === undefined) return yield* Effect.dieMessage(`Unknown workspace ${workspace_id}`);
      return Schema.decodeUnknownSync(DbSafeInt)(row.value);
    }
    const key = `${column}:${workspace_id}`;
    let current = state.counters.get(key);
    if (current === undefined) {
      // Straight from the backend, past the read-after-write check: this transaction has not written the counter.
      const [row] = (yield* state.backend.run({ sql: `SELECT ${column} AS value FROM workspaces WHERE id = ?`, params: [workspace_id] })).rows;
      if (row === undefined) return yield* fail(`Unknown workspace ${workspace_id}`);
      current = Schema.decodeUnknownSync(DbSafeInt)(row.value);
      // The commit guard watches tx_clock, which an autocommit increment does not bump: guard the counter itself.
      yield* sql`INSERT INTO tx_conflict (v) SELECT 1 WHERE (SELECT ${sql(column)} FROM workspaces WHERE id = ${workspace_id}) <> ${current}`;
    }
    const next = current + 1;
    state.counters.set(key, next);
    yield* sql`UPDATE workspaces SET ${sql(column)} = ${next} WHERE id = ${workspace_id}`;
    return next;
  });

/** Next committed-order context sequence number; call inside the change's transaction. */
export const nextContextSeq: (workspace_id: WorkspaceId) => Effect.Effect<number, SqlError.SqlError, SqlClient.SqlClient> = increment('context_seq');
