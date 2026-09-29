/** Per-suite disposable database on the shared test server plus the application layer for it. */
import { randomBytes } from 'node:crypto';
import type { SqlClient } from '@effect/sql';
import { Effect, Redacted } from 'effect';
import { createConnection } from 'mysql2/promise';
import { inject } from 'vitest';
import { dbLayer, type MysqlOptions } from '../../src/db.ts';
import { loadMigrations, migrate } from '../../src/migrate.ts';

export interface TestDatabase {
  readonly name: string;
  readonly mysql: MysqlOptions;
}

const admin = () => createConnection(inject('mysqlAdminUrl'));

/** Creates `sanctum_t_<random>`; the returned `drop` removes it. */
export async function createTestDatabase(): Promise<TestDatabase & { drop: () => Promise<void> }> {
  const name = `sanctum_t_${randomBytes(6).toString('hex')}`;
  const connection = await admin();
  await connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await connection.end();
  const url = new URL(inject('mysqlAdminUrl'));
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
