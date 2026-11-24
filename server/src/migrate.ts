/**
 * Applies `migrations-d1/NNNN_name.sql` to a `file:` or in-memory database for local runs, CI and tests.
 * D1 itself is migrated by `wrangler d1 migrations apply sanctum`, which records applied files in the same
 * `d1_migrations` table, so API and worker check readiness the same way on both.
 *
 * Each file runs in one SQLite transaction (DDL is transactional), so a failing file leaves nothing behind.
 *
 * Run explicitly (`npm run migrate --workspace server`); API and worker only check status.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { SqlClient } from '@effect/sql';
import { NodeRuntime } from '@effect/platform-node';
import { Data, Effect } from 'effect';
import { serverConfig } from './config.ts';
import { dbLayer } from './db.ts';

export class MigrationError extends Data.TaggedError('MigrationError')<{ readonly message: string }> { }

export interface Migration {
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

/**
 * Splits a file into statements: `--` comment lines are dropped and a statement ends with `;` at end of line,
 * except inside `CREATE TRIGGER ... BEGIN ... END;`, which ends at the line `END;`.
 */
const splitStatements = (text: string) => {
  const statements: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('--')) continue;
    current += `${line}\n`;
    const trigger = /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(current);
    if (trigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line)) {
      statements.push(current.trim().replace(/;$/, ''));
      current = '';
    }
  }
  if (current.trim() !== '') throw new MigrationError({ message: `Unterminated statement: ${current.trim().slice(0, 60)}` });
  return statements;
};

export function parseMigration(file: string, text: string): Migration {
  if (!/^\d{4}_\w+\.sql$/.test(file)) throw new MigrationError({ message: `Invalid migration file name: ${file}` });
  return { name: file, statements: splitStatements(text) };
}

const MIGRATIONS_DIR = new URL('../migrations-d1/', import.meta.url);

export function loadMigrations(dir: URL = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => parseMigration(file, readFileSync(new URL(file, dir), 'utf8')));
}

const ensureLedger = Effect.flatMap(SqlClient.SqlClient, sql =>
  sql`CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);

const appliedNames = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const [ledger] = yield* sql`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'`;
  return new Set(ledger === undefined ? [] : (yield* sql<{ name: string }>`SELECT name FROM d1_migrations`).map(row => row.name));
});

const applyFile = (migration: Migration) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe('BEGIN');
    yield* Effect.gen(function*() {
      for (const statement of migration.statements) yield* sql.unsafe(statement);
      yield* sql`INSERT INTO d1_migrations (name) VALUES (${migration.name})`;
      yield* sql.unsafe('COMMIT');
    }).pipe(Effect.tapErrorCause(() => Effect.ignore(sql.unsafe('ROLLBACK'))));
  });

/** Applies pending migrations in name order; rerunning applies nothing. */
export const migrate = (migrations: ReadonlyArray<Migration>) =>
  Effect.gen(function*() {
    yield* ensureLedger;
    const done = yield* appliedNames;
    const applied: string[] = [];
    for (const migration of migrations.filter(candidate => !done.has(candidate.name))) {
      yield* applyFile(migration);
      applied.push(migration.name);
    }
    return { applied } as const;
  });

/** Pending migration names; API readiness and worker startup refuse to run while any remain. */
export const pendingMigrations = (migrations: ReadonlyArray<Migration>) =>
  Effect.map(appliedNames, done => migrations.filter(migration => !done.has(migration.name)).map(migration => migration.name));

export const requireCurrentSchema = (migrations: ReadonlyArray<Migration>) =>
  Effect.flatMap(pendingMigrations(migrations), pending =>
    pending.length === 0 ? Effect.void : new MigrationError({ message: `Schema is behind; pending migrations: ${pending.join(', ')}` }),
  );

if (import.meta.main) {
  Effect.gen(function*() {
    const config = yield* serverConfig;
    if (/^https?:/.test(config.db.url)) return yield* new MigrationError({ message: 'D1 is migrated with `wrangler d1 migrations apply sanctum`, not this command' });
    const report = yield* migrate(loadMigrations()).pipe(Effect.provide(dbLayer(config.db)));
    yield* Effect.logInfo('Migrations complete', report);
  }).pipe(NodeRuntime.runMain);
}
