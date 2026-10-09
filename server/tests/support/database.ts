/** Per-suite disposable database on the shared test server plus the application layer for it. */
import { randomBytes } from 'node:crypto';
import type { SqlClient } from '@effect/sql';
import { Effect, Redacted } from 'effect';
import { createConnection } from 'mysql2/promise';
import { dbLayer, type MysqlOptions } from '../../src/db.ts';
import { loadMigrations, migrate } from '../../src/migrate.ts';

export interface TestDatabase {
  readonly name: string;
  readonly mysql: MysqlOptions;
}

/** Creates `sanctum_t_<random>` on the server at `adminUrl`; the returned `drop` removes it. Usable outside Vitest. */
export async function createDatabaseOn(adminUrl: string): Promise<TestDatabase & { drop: () => Promise<void> }> {
  const admin = () => createConnection(adminUrl);
  const name = `sanctum_t_${randomBytes(6).toString('hex')}`;
  const connection = await admin();
  await connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await connection.end();
  const url = new URL(adminUrl);
  const mysql = {
    host: url.hostname,
    port: Number(url.port),
    database: name,
    username: decodeURIComponent(url.username),
    password: Redacted.make(decodeURIComponent(url.password)),
    maxConnections: 4,
    queueLimit: 50,
  };
  const drop = async () => {
    const cleanup = await admin();
    await cleanup.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await cleanup.end();
  };
  return { name, mysql, drop };
}

/** A database on the Vitest run's shared server (Vitest is imported lazily so other processes can load this module). */
export const createTestDatabase = async () => createDatabaseOn((await import('vitest')).inject('mysqlAdminUrl'));

/** A fresh database dropped with the scope; migrate it with `migrateDatabase`. */
export const freshDatabase = Effect.acquireRelease(Effect.promise(createTestDatabase), database => Effect.promise(database.drop));

export const migrateDatabase = (database: TestDatabase) => Effect.provide(migrate(loadMigrations()), dbLayer(database.mysql));

/** Runs `effect` against `database` and resolves with its result. */
export const runSql = <A, E>(database: TestDatabase, effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.runPromise(Effect.provide(effect, dbLayer(database.mysql)));

/** Runs `use` against a fresh database (optionally fully migrated) and drops it afterwards. */
export const withDatabase = <A, E>(use: Effect.Effect<A, E, SqlClient.SqlClient>, options: { readonly migrated?: boolean } = {}) =>
  Effect.acquireUseRelease(
    Effect.promise(createTestDatabase),
    database => {
      const prepared = options.migrated ? Effect.zipRight(migrate(loadMigrations()), use) : use;
      return Effect.provide(prepared, dbLayer(database.mysql));
    },
    database => Effect.promise(database.drop),
  );
