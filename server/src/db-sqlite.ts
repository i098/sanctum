/** `node:sqlite` backend for local runs, CI and compose: one synchronous connection, so each statement and batch is atomic. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SqlError } from '@effect/sql';
import { Effect, type Scope } from 'effect';
import type { DbBackend, DbResult, DbStatement } from './db-types.ts';

const sqlError = (cause: unknown) => new SqlError.SqlError({ cause, message: cause instanceof Error ? cause.message : String(cause) });

/** D1's statement limits (developers.cloudflare.com/d1/platform/limits), so local runs and CI fail where production would. The `limits` option needs Node 24.15 (`engines`). */
const D1_LIMITS = { length: 2_000_000, sqlLength: 100_000, column: 100, functionArg: 32, likePatternLength: 50, variableNumber: 100, compoundSelect: 5 };

const bind = (params: ReadonlyArray<unknown>) => params.map(value => (typeof value === 'boolean' ? Number(value) : value === undefined ? null : value) as SQLInputValue);

const execute = (database: DatabaseSync, { sql, params }: DbStatement): DbResult => {
  const statement = database.prepare(sql);
  if (statement.columns().length > 0) {
    const rows = statement.all(...bind(params)) as Array<Record<string, unknown>>;
    return { rows, changes: rows.length };
  }
  return { rows: [], changes: Number(statement.run(...bind(params)).changes) };
};

/** `path` is `:memory:`, `file:<path>`, a bare path, or a `file:` URI with a query (`file:name?mode=memory&cache=shared` shares one memory database between connections). */
export const sqliteBackend = (path: string): Effect.Effect<DbBackend, SqlError.SqlError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const database = new DatabaseSync(path.includes('?') ? path : path.replace(/^file:/, ''), { limits: D1_LIMITS });
        database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
        return database;
      },
      catch: sqlError,
    }),
    database => Effect.sync(() => database.close()),
  ).pipe(
    Effect.map((database): DbBackend => ({
      run: statement => Effect.try({ try: () => execute(database, statement), catch: sqlError }),
      batch: statements =>
        Effect.try({
          try: () => {
            database.exec('BEGIN IMMEDIATE');
            try {
              const results = statements.map(statement => execute(database, statement));
              database.exec('COMMIT');
              return results;
            } catch (error) {
              if (database.isTransaction) database.exec('ROLLBACK');
              throw error;
            }
          },
          catch: sqlError,
        }),
    })),
  );
