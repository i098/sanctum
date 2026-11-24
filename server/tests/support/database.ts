/** Per-suite disposable in-memory SQLite database plus the application layer for it. */
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SqlClient } from '@effect/sql';
import { Effect } from 'effect';
import { type DbOptions, dbLayer } from '../../src/db.ts';
import { loadMigrations, migrate } from '../../src/migrate.ts';

export interface TestDatabase {
  readonly name: string;
  readonly db: DbOptions;
}

/**
 * A uniquely named shared-cache memory database: every `dbLayer(database.db)` connects to the same data.
 * `drop` closes it and frees the data.
 */
export async function createEmptyDatabase(): Promise<TestDatabase & { drop: () => Promise<void> }> {
  const name = `sanctum_t_${randomBytes(6).toString('hex')}`;
  const db = { url: `file:${name}?mode=memory&cache=shared` };
  // The data lives while one connection is open, so this one stays until `drop`.
  const keeper = new DatabaseSync(db.url);
  return { name, db, drop: async () => keeper.close() };
}

/** An empty database with every `migrations-d1` file applied. */
export async function createTestDatabase() {
  const database = await createEmptyDatabase();
  await migrateDatabase(database);
  return database;
}

/** A fresh migrated database dropped with the scope. */
export const freshDatabase = Effect.acquireRelease(Effect.promise(() => createTestDatabase()), database => Effect.promise(database.drop));

export const migrateDatabase = (database: TestDatabase) => Effect.runPromise(Effect.provide(migrate(loadMigrations()), dbLayer(database.db)));

/** Runs `effect` against `database` and resolves with its result. */
export const runSql = <A, E>(database: TestDatabase, effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.runPromise(Effect.provide(effect, dbLayer(database.db)));

/** Runs `use` against a fresh database (empty unless `migrated`) and drops it afterwards. */
export const withDatabase = <A, E>(use: Effect.Effect<A, E, SqlClient.SqlClient>, options: { readonly migrated?: boolean } = {}) =>
  Effect.acquireUseRelease(
    Effect.promise(options.migrated === true ? createTestDatabase : createEmptyDatabase),
    database => Effect.provide(use, dbLayer(database.db)),
    database => Effect.promise(database.drop),
  );
