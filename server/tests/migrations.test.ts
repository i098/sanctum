import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { loadMigrations, migrate, parseMigration, pendingMigrations, requireCurrentSchema, type Migration } from '../src/migrate.ts';
import { withDatabase } from './support/database.ts';

const migrations = loadMigrations();
const stepCount = migrations.reduce((total, migration) => total + migration.steps.length, 0);

const tables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ name: string }>`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`;
  return rows.map(row => row.name);
});

describe('migration files', () => {
  it('are numbered, parsed into inspectable steps and create every plan section 07 table', () => {
    expect(migrations.map(migration => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const created = migrations.flatMap(migration => migration.steps.map(step => step.object.table));
    expect(created).toEqual(
      expect.arrayContaining([
        'workspaces', 'principals', 'workspace_members', 'meetings', 'meeting_access', 'listeners', 'recording_chunks',
        'meeting_ranges', 'transcript_segments', 'speaker_tracks', 'voice_enrollments', 'profile_embeddings',
        'context_items', 'context_events', 'agent_credentials', 'integration_accounts', 'action_grants', 'actions', 'jobs',
        'workspace_orgs', 'sync_cursors',
      ]),
    );
  });

  it('rejects names and statements the runner cannot inspect after a crash', () => {
    expect(() => parseMigration('1_bad.sql', 'CREATE TABLE a (id INT);')).toThrow(/Invalid migration file name/);
    expect(() => parseMigration('010_drop.sql', 'DROP TABLE a;')).toThrow(/idempotent UPDATE steps/);
    expect(() => parseMigration('010_alter.sql', 'ALTER TABLE a ADD COLUMN b INT, ADD COLUMN c INT;')).toThrow(/single ADD COLUMN/);
    const parsed = parseMigration('010_ok.sql', '-- comment\nCREATE TABLE a (id INT);\nCREATE UNIQUE INDEX a_id ON a (id);\nALTER TABLE a ADD COLUMN b VARCHAR(10) NULL;\nALTER TABLE a MODIFY COLUMN b VARCHAR(20) NULL;\n');
    expect(parsed.steps.map(step => step.object)).toEqual([{ kind: 'table', table: 'a' }, { kind: 'index', table: 'a', index: 'a_id' }, { kind: 'column', table: 'a', column: 'b' }, { kind: 'backfill', table: 'a' }]);
  });
});

describe('migrate against MySQL 8.4', () => {
  it.effect('applies a fresh database once and is a no-op when repeated', () =>
    withDatabase(
      Effect.gen(function* () {
        expect(yield* pendingMigrations(migrations)).toEqual(migrations.map(migration => migration.version));
        const first = yield* migrate(migrations);
        expect(first.applied).toHaveLength(stepCount);
        const second = yield* migrate(migrations);
        expect(second).toEqual({ applied: [], adopted: [] });
        expect(yield* pendingMigrations(migrations)).toEqual([]);
        yield* requireCurrentSchema(migrations);
        expect(yield* tables).toContain('profile_embeddings');
      }),
    ),
  );

  it.effect('serializes concurrent runners through the execution lock', () =>
    withDatabase(
      Effect.gen(function* () {
        const reports = yield* Effect.all([migrate(migrations), migrate(migrations)], { concurrency: 2 });
        expect(reports.flatMap(report => report.applied)).toHaveLength(stepCount);
      }),
    ),
  );

  it.effect('resumes after DDL ran but its ledger step was not recorded', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrate(migrations);
        // Simulate a crash between CREATE TABLE and its ledger insert in the last migration.
        const last = migrations.at(-1)!;
        yield* sql`DELETE FROM schema_migration_steps WHERE version = ${last.version}`;
        yield* sql`UPDATE schema_migrations SET completed_at = NULL WHERE version = ${last.version}`;
        const report = yield* migrate(migrations);
        expect(report.applied).toHaveLength(last.steps.filter(step => step.object.kind === 'backfill').length);
        expect(report.adopted).toHaveLength(last.steps.filter(step => step.object.kind !== 'backfill').length);
        expect(yield* pendingMigrations(migrations)).toEqual([]);
      }),
    ),
  );

  it.effect('backfills the issuer of members already managed by organization sync', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrate(migrations.filter(migration => migration.version < 16));
        yield* sql`INSERT INTO workspaces (id, name, timezone, created_at) VALUES ('w-linked', 'Linked', 'UTC', UTC_TIMESTAMP(6)), ('w-free', 'Free', 'UTC', UTC_TIMESTAMP(6))`;
        yield* sql`INSERT INTO principals (id, kind, display_name, created_at) VALUES ('p-1', 'human', 'One', UTC_TIMESTAMP(6)), ('p-2', 'human', 'Two', UTC_TIMESTAMP(6))`;
        yield* sql`INSERT INTO workspace_members (workspace_id, principal_id, role, created_at, revoked_at) VALUES
          ('w-linked', 'p-1', 'owner', UTC_TIMESTAMP(6), NULL), ('w-linked', 'p-2', 'member', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)), ('w-free', 'p-1', 'owner', UTC_TIMESTAMP(6), NULL)`;
        yield* sql`INSERT INTO workspace_orgs (issuer, org_id, workspace_id, created_at) VALUES ('https://issuer.test', 'org_1', 'w-linked', UTC_TIMESTAMP(6))`;
        yield* migrate(migrations);
        const rows = yield* sql<{ workspace_id: string; principal_id: string; org_issuer: string | null }>`SELECT workspace_id, principal_id, org_issuer FROM workspace_members ORDER BY workspace_id, principal_id`;
        expect(rows).toEqual([
          { workspace_id: 'w-free', principal_id: 'p-1', org_issuer: null },
          { workspace_id: 'w-linked', principal_id: 'p-1', org_issuer: 'https://issuer.test' },
          { workspace_id: 'w-linked', principal_id: 'p-2', org_issuer: null },
        ]);
      }),
    ),
  );

  it.effect('continues a partially applied migration from its next step', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const first = migrations[0]!;
        const partial: Migration = { ...first, steps: first.steps.slice(0, 2) };
        yield* migrate([partial]);
        yield* sql`UPDATE schema_migrations SET completed_at = NULL WHERE version = ${first.version}`;
        const report = yield* migrate(migrations);
        expect(report.applied).toHaveLength(stepCount - 2);
      }),
    ),
  );

  it.effect('refuses objects created outside the ledger and edited applied migrations', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE workspaces (id INT PRIMARY KEY)`;
        const conflict = yield* Effect.exit(migrate(migrations));
        expect(Exit.isFailure(conflict) && String(conflict.cause)).toMatch(/already exists outside the ledger/);
        yield* sql`DROP TABLE workspaces`;
        yield* sql`DELETE FROM schema_migrations`;
        yield* migrate(migrations);
        const edited = migrations.map((migration, index) => (index === 0 ? { ...migration, checksum: 'edited' } : migration));
        const exit = yield* Effect.exit(migrate(edited));
        expect(Exit.isFailure(exit) && String(exit.cause)).toMatch(/was edited/);
      }),
    ),
  );

  it.effect('reports a behind schema to API readiness and worker startup', () =>
    withDatabase(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(requireCurrentSchema(migrations));
        expect(Exit.isFailure(exit) && String(exit.cause)).toMatch(/pending migrations: 1, 2/);
      }),
    ),
  );

  it.effect('adds the End fence window to capture epochs as two nullable columns with no default, so existing epochs stay unfenced', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrate(migrations);
        const columns = yield* sql`SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME LIKE 'end_fence%' ORDER BY COLUMN_NAME`;
        expect(columns).toEqual([
          { tbl: 'capture_epochs', name: 'end_fence_from_sample', nullable: 'YES', dflt: null },
          { tbl: 'capture_epochs', name: 'end_fence_sample', nullable: 'YES', dflt: null },
        ]);
      }),
    ),
  );
});
