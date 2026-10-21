/**
 * The one MySQL boundary (plan section 07): bounded pool, UTC sessions, and column schemas
 * that turn mysql2 row values into wire-ready values. Domain code decodes rows with
 * `SqlSchema` from `@effect/sql` using these column schemas; nothing else touches raw rows.
 */
import * as Reactivity from '@effect/experimental/Reactivity';
import { MysqlClient } from '@effect/sql-mysql2';
import { SqlClient, type SqlConnection, SqlError } from '@effect/sql';
import { Context, Effect, Exit, Fiber, Layer, ParseResult, type Redacted, Schema, Scope, Stream } from 'effect';
import { Sha256Hex, UtcTimestamp, Unavailable, type WorkspaceId } from '@sanctum/contracts';

/** Connection settings; config.ts reads them from the environment. */
export interface MysqlOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: Redacted.Redacted;
  readonly maxConnections: number;
  readonly queueLimit: number;
  /** PEM CA certificate; when set, TLS is required and verified, including the server host name. */
  readonly caCert?: string | undefined;
}

/**
 * Pool options: DATETIME(6) and BIGINT/DECIMAL arrive as strings (no millisecond Date or
 * rounded Number), connection waits are bounded by `queueLimit`; without `caCert` the
 * connection is unencrypted (local and test servers).
 */
const pooledClient = (mysql: MysqlOptions) =>
  MysqlClient.layer({
    host: mysql.host,
    port: mysql.port,
    database: mysql.database,
    username: mysql.username,
    password: mysql.password,
    maxConnections: mysql.maxConnections,
    poolConfig: {
      charset: 'utf8mb4_0900_ai_ci',
      timezone: 'Z',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      waitForConnections: true,
      queueLimit: mysql.queueLimit,
      connectTimeout: 10_000,
      enableKeepAlive: true,
      ...(mysql.caCert === undefined ? {} : { ssl: { ca: mysql.caCert, verifyIdentity: true } }),
    },
  });

/**
 * mysql2 cannot run per-connection init SQL through the Effect client, so the server (or its
 * host) must run in UTC; refuse to start otherwise. SQL uses UTC_TIMESTAMP(6), never NOW().
 */
export const verifyUtcSession = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ tz: string; system_tz: string }>`SELECT @@session.time_zone AS tz, @@system_time_zone AS system_tz`;
  const utc = row?.tz === '+00:00' || row?.tz === 'UTC' || (row?.tz === 'SYSTEM' && row.system_tz === 'UTC');
  if (!utc) {
    return yield* new Unavailable({ message: `MySQL session time zone must be UTC, got ${row?.tz}/${row?.system_tz}`, retryable: false });
  }
});

/**
 * The pool cannot drop a waiter: mysql2 keeps the queued callback of a cancelled request, and
 * @effect/sql-mysql2 then still dispatches that request's statement once a connection frees.
 * Waiting therefore happens here, in a FIFO semaphore whose waiters leave when interrupted;
 * a statement or transaction asks the pool for a connection only while holding one of its
 * `maxConnections` permits, so the pool's own queue never forms. A statement already dispatched
 * is not cancelled: MySQL runs it to completion and keeps its permit and connection until then.
 * As in mysql2, more than `queueLimit` waiters are refused (0 is unbounded).
 */
const gatedClient = (mysql: MysqlOptions) =>
  Layer.scopedContext(
    Effect.gen(function* () {
      const pooled = yield* MysqlClient.MysqlClient;
      const permits = yield* Effect.makeSemaphore(mysql.maxConnections);
      let busy = 0;
      let waiting = 0;
      const giveBack = Effect.suspend(() => {
        busy--;
        return permits.release(1);
      });
      // Waiting is interruptible only where the caller is: a cleanup write of an interrupted fiber still waits its turn.
      const reserve = Effect.uninterruptibleMask(restore =>
        Effect.suspend(() => {
          if (busy >= mysql.maxConnections && mysql.queueLimit > 0 && waiting >= mysql.queueLimit) return Effect.fail(new SqlError.SqlError({ cause: new Error('Queue limit reached.'), message: 'Failed to acquire connection' }));
          waiting++;
          return restore(permits.take(1)).pipe(Effect.onExit(exit => Effect.sync(() => { waiting--; if (Exit.isSuccess(exit)) busy++; })));
        }).pipe(
          // A failed acquisition leaves no finalizer behind and its scope may never close, so the permit goes back here.
          Effect.zipRight(Effect.onError(pooled.reserve, () => giveBack)),
          Effect.tap(() => Effect.addFinalizer(() => giveBack)),
        ),
      );
      // An interrupted statement is not aborted: MySQL still runs it on its connection, which must not be handed out before it
      // answers. A daemon therefore owns the permit and connection until then, while the caller may leave at once.
      const held = <A>(use: (connection: SqlConnection.Connection) => Effect.Effect<A, SqlError.SqlError>) =>
        Effect.uninterruptibleMask(restore =>
          Effect.flatMap(Scope.make(), scope =>
            restore(Scope.extend(reserve, scope)).pipe(
              Effect.flatMap(connection => Effect.forkDaemon(Effect.onExit(use(connection), exit => Scope.close(scope, exit)))),
              Effect.flatMap(statement => restore(Fiber.join(statement))),
            ),
          ),
        );
      const statements: SqlConnection.Connection = {
        execute: (sql, params, transform) => held(c => c.execute(sql, params, transform)),
        executeRaw: (sql, params) => held(c => c.executeRaw(sql, params)),
        executeValues: (sql, params) => held(c => c.executeValues(sql, params)),
        executeUnprepared: (sql, params, transform) => held(c => c.executeUnprepared(sql, params, transform)),
        executeStream: (sql, params, transform) => Stream.unwrapScoped(Effect.map(reserve, c => c.executeStream(sql, params, transform))),
      };
      const client = yield* SqlClient.make({
        acquirer: Effect.succeed(statements),
        transactionAcquirer: reserve,
        compiler: MysqlClient.makeCompiler(),
        spanAttributes: [['db.system.name', 'mysql']],
      });
      return Context.make(SqlClient.SqlClient, client);
    }),
  ).pipe(Layer.provide(Reactivity.layer), Layer.provide(pooledClient(mysql)));

/** Pool plus the UTC precondition; API and worker each build their own process-scoped layer. */
export const dbLayer = (mysql: MysqlOptions) => Layer.effectDiscard(verifyUtcSession).pipe(Layer.provideMerge(gatedClient(mysql)));

const MYSQL_DATETIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)$/;

/** DATETIME(6) string `2026-09-26 17:08:16.123456` <-> UTC wire timestamp, preserving microseconds. */
export const DbUtc = Schema.transform(Schema.String.pipe(Schema.pattern(MYSQL_DATETIME)), UtcTimestamp, {
  strict: true,
  decode: value => value.replace(MYSQL_DATETIME, '$1T$2Z'),
  encode: value => value.slice(0, -1).replace('T', ' '),
});

/** BIGINT/DECIMAL string (or small number) -> exact safe integer; unsafe values fail instead of rounding. */
export const DbSafeInt = Schema.transformOrFail(Schema.Union(Schema.String, Schema.Number), Schema.Number, {
  strict: true,
  decode: (value, _, ast) => {
    const parsed = typeof value === 'number' ? value : /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
    return Number.isSafeInteger(parsed) ? ParseResult.succeed(parsed) : ParseResult.fail(new ParseResult.Type(ast, value, 'not a safe integer'));
  },
  encode: value => ParseResult.succeed(value),
});

/** TINYINT(1)/BOOLEAN -> boolean. */
export const DbBool = Schema.transform(Schema.Literal(0, 1), Schema.Boolean, {
  strict: true,
  decode: value => value === 1,
  encode: value => (value ? 1 : 0),
});

/** Native JSON column: mysql2 returns parsed values; parameters are sent as JSON text. */
export const DbJson = <A, I>(schema: Schema.Schema<A, I>) => Schema.Union(Schema.parseJson(schema), schema);

/** BINARY(32) SHA-256 <-> lowercase hex. */
export const DbSha256 = Schema.transform(Schema.Uint8ArrayFromSelf, Sha256Hex, {
  strict: true,
  decode: bytes => Buffer.from(bytes).toString('hex'),
  encode: hex => Buffer.from(hex, 'hex'),
});

/** MySQL server error number of a failed statement, e.g. 1062 duplicate key, 1452 foreign key. */
export const mysqlErrno = (error: SqlError.SqlError): number | undefined => {
  const cause: unknown = error.cause;
  return typeof cause === 'object' && cause !== null && 'errno' in cause && typeof cause.errno === 'number' ? cause.errno : undefined;
};

export const ER_DUP_ENTRY = 1062;
export const ER_NO_REFERENCED_ROW = 1452;
export const ER_CHECK_CONSTRAINT_VIOLATED = 3819;

/**
 * `LAST_INSERT_ID(expr)` makes the increment and its read one statement; the row lock it takes
 * lasts until the caller's transaction commits, which serializes allocation per workspace.
 */
export const increment = (column: 'context_seq' | 'permission_revision') => (workspace_id: WorkspaceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const result = (yield* sql`UPDATE workspaces SET ${sql(column)} = LAST_INSERT_ID(${sql(column)} + 1) WHERE id = ${workspace_id}`.raw) as { readonly affectedRows: number; readonly insertId: number | string };
    if (result.affectedRows !== 1) return yield* Effect.dieMessage(`Unknown workspace ${workspace_id}`);
    return Schema.decodeUnknownSync(DbSafeInt)(result.insertId);
  });

/** Next committed-order context sequence number; call inside the change's transaction. */
export const nextContextSeq: (workspace_id: WorkspaceId) => Effect.Effect<number, SqlError.SqlError, SqlClient.SqlClient> = increment('context_seq');
