import type { Effect } from 'effect';
import type { SqlError } from '@effect/sql';

/** `SANCTUM_DB_URL`: `file:<path>`, `:memory:`, or the D1 gateway `http://d1.internal`. */
export interface DbOptions { readonly url: string }
export interface DbStatement { readonly sql: string; readonly params: ReadonlyArray<unknown> }
export interface DbResult { readonly rows: ReadonlyArray<Record<string, unknown>>; readonly changes: number }
export interface DbBackend {
  readonly run: (statement: DbStatement) => Effect.Effect<DbResult, SqlError.SqlError>;
  /** All statements commit together or none does. */
  readonly batch: (statements: ReadonlyArray<DbStatement>) => Effect.Effect<ReadonlyArray<DbResult>, SqlError.SqlError>;
}
