import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { loadMigrations, migrate, parseMigration, pendingMigrations, requireCurrentSchema } from '../src/migrate.ts';
import { createTestDatabase, withDatabase } from './support/database.ts';

const migrations = loadMigrations();

const tables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
  return rows.map(row => row.name);
});

describe('migration files', () => {
  it('are numbered and create the transaction guard and every core table', () => {
    expect(migrations.map(migration => migration.name)[0]).toBe('0001_baseline.sql');
    const created = migrations.flatMap(migration => migration.statements.flatMap(statement => /^CREATE (?:VIRTUAL )?TABLE (\w+)/i.exec(statement)?.[1] ?? []));
    expect(created).toEqual(expect.arrayContaining(['tx_clock', 'tx_conflict', 'workspaces', 'principals', 'meetings', 'jobs', 'context_items', 'context_items_fts']));
  });

  it('splits statements, keeps trigger bodies whole and rejects bad names and unterminated text', () => {
    const parsed = parseMigration('0002_x.sql', '-- comment\nCREATE TABLE a (id INTEGER);\nCREATE TRIGGER t AFTER INSERT ON a BEGIN\n  INSERT INTO a VALUES (1);\n  DELETE FROM a;\nEND;\nCREATE INDEX i ON a (id);\n');
    expect(parsed.statements.map(statement => statement.split(/\s+/).slice(0, 3).join(' '))).toEqual(['CREATE TABLE a', 'CREATE TRIGGER t', 'CREATE INDEX i']);
    expect(parsed.statements[1]).toMatch(/DELETE FROM a;\nEND$/);
    expect(() => parseMigration('2_bad.sql', 'CREATE TABLE a (id INTEGER);')).toThrow(/Invalid migration file name/);
    expect(() => parseMigration('0003_x.sql', 'CREATE TABLE a (id INTEGER)')).toThrow(/Unterminated/);
  });
});

describe('migrate', () => {
  it.effect('applies a fresh database once and is a no-op when repeated', () =>
    withDatabase(
      Effect.gen(function* () {
        expect(yield* pendingMigrations(migrations)).toEqual(migrations.map(migration => migration.name));
        expect((yield* migrate(migrations)).applied).toEqual(migrations.map(migration => migration.name));
        expect((yield* migrate(migrations)).applied).toEqual([]);
        expect(yield* pendingMigrations(migrations)).toEqual([]);
        yield* requireCurrentSchema(migrations);
        expect(yield* tables).toEqual(expect.arrayContaining(['d1_migrations', 'tx_clock', 'workspaces']));
      }),
    ),
  );

  it.effect('requireCurrentSchema fails while a migration is pending', () =>
    withDatabase(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(requireCurrentSchema(migrations));
        expect(Exit.isFailure(exit) && String(exit.cause)).toMatch(/pending migrations: 0001_baseline/);
      }),
    ),
  );

  it.effect('a failing file leaves nothing behind and is not recorded', () =>
    withDatabase(
      Effect.gen(function* () {
        const broken = parseMigration('0001_broken.sql', 'CREATE TABLE a (id INTEGER);\nCREATE TABLE a (id INTEGER);\n');
        const exit = yield* Effect.exit(migrate([broken]));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* tables).not.toContain('a');
        expect(yield* pendingMigrations([broken])).toEqual(['0001_broken.sql']);
      }),
    ),
  );

  it('createTestDatabase returns a migrated database that every connection shares', async () => {
    const database = await createTestDatabase();
    try {
      const reader = new DatabaseSync(database.db.url);
      expect(reader.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'workspaces'").get()).toEqual({ n: 1 });
      reader.close();
    } finally {
      await database.drop();
    }
  });

  it('npm run migrate applies migrations-d1 to a file database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sanctum-migrate-'));
    try {
      const path = join(directory, 'app.db');
      execFileSync(process.execPath, ['src/migrate.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, SANCTUM_DB_URL: `file:${path}` }, stdio: 'pipe' });
      const database = new DatabaseSync(path);
      expect(database.prepare('SELECT name FROM d1_migrations').all().map(row => row['name'])).toEqual(migrations.map(migration => migration.name));
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
