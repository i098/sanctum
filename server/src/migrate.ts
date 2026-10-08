/**
 * Versioned schema migrations for MySQL 8.4 (plan sections 07 and 16).
 *
 * MySQL DDL implicitly commits, so a migration file cannot be rolled back as a unit. Each
 * file is split into single-object steps (CREATE TABLE / CREATE INDEX / ALTER TABLE ... ADD COLUMN,
 * each atomic DDL in MySQL 8.4) recorded one by one in a ledger under a named execution lock. After a crash
 * between a step and its ledger row, the rerun inspects information_schema: an object that
 * exists for a migration this ledger already started is adopted, any other pre-existing
 * object stops the run. Applied steps and completed files are checksum-verified.
 *
 * Run explicitly (`npm run migrate --workspace server`); API and worker only check status.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { SqlClient } from '@effect/sql';
import { NodeRuntime } from '@effect/platform-node';
import { Data, Effect } from 'effect';
import { serverConfig } from './config.ts';
import { dbLayer } from './db.ts';

export class MigrationError extends Data.TaggedError('MigrationError')<{ readonly message: string }> { }

type SchemaObject =
  | { readonly kind: 'table'; readonly table: string }
  | { readonly kind: 'index'; readonly table: string; readonly index: string }
  | { readonly kind: 'column'; readonly table: string; readonly column: string };

export interface MigrationStep {
  readonly index: number;
  readonly sql: string;
  readonly checksum: string;
  readonly object: SchemaObject;
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly steps: ReadonlyArray<MigrationStep>;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const TABLE = /^CREATE TABLE `?(\w+)`?/i;
const INDEX = /^CREATE (?:UNIQUE |FULLTEXT )?INDEX `?(\w+)`? ON `?(\w+)`?/i;
/** One column per statement, so the step stays a single inspectable object. */
const COLUMN = /^ALTER TABLE `?(\w+)`? ADD COLUMN `?(\w+)`?[^,]*$/i;

function schemaObject(statement: string, file: string): SchemaObject {
  const table = TABLE.exec(statement);
  if (table) return { kind: 'table', table: table[1]! };
  const index = INDEX.exec(statement);
  if (index) return { kind: 'index', index: index[1]!, table: index[2]! };
  const column = COLUMN.exec(statement);
  if (column) return { kind: 'column', table: column[1]!, column: column[2]! };
  throw new MigrationError({ message: `${file}: only CREATE TABLE, CREATE INDEX and single ADD COLUMN steps can be inspected after a crash: ${statement.slice(0, 60)}` });
}

/** Parses `NNN_name.sql`: `--` comment lines are dropped and statements end with `;` at end of line. */
export function parseMigration(file: string, text: string): Migration {
  const match = /^(\d{3})_(\w+)\.sql$/.exec(file);
  if (!match) throw new MigrationError({ message: `Invalid migration file name: ${file}` });
  const body = text.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
  const statements = body.split(/;\s*$/m).map(statement => statement.trim()).filter(Boolean);
  const steps = statements.map((sql, index) => ({ index, sql, checksum: sha256(sql), object: schemaObject(sql, file) }));
  return { version: Number(match[1]), name: match[2]!, checksum: sha256(steps.map(step => step.checksum).join('\n')), steps };
}

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

export function loadMigrations(dir: URL = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => parseMigration(file, readFileSync(new URL(file, dir), 'utf8')));
  const versions = new Set(migrations.map(migration => migration.version));
  if (versions.size !== migrations.length) throw new MigrationError({ message: 'Duplicate migration version' });
  return migrations;
}

const ensureLedger = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT UNSIGNED NOT NULL PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        checksum CHAR(64) CHARACTER SET ascii NOT NULL,
        started_at DATETIME(6) NOT NULL,
        completed_at DATETIME(6) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
  yield* sql`CREATE TABLE IF NOT EXISTS schema_migration_steps (
        version INT UNSIGNED NOT NULL,
        step INT UNSIGNED NOT NULL,
        checksum CHAR(64) CHARACTER SET ascii NOT NULL,
        outcome ENUM('applied', 'adopted') NOT NULL,
        recorded_at DATETIME(6) NOT NULL,
        PRIMARY KEY (version, step)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
});

/** Named locks are server-wide; scope ours to the schema being migrated (names are limited to 64 chars). */
const LOCK_NAME = "CONCAT('sanctum_migrate:', LEFT(SHA2(DATABASE(), 256), 40))";

/** Holds a MySQL named lock on one reserved connection for the duration of `effect`. */
const withMigrationLock = <A, E, R>(effect: Effect.Effect<A, E, R>, timeoutSeconds: number) =>
  Effect.scoped(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient;
      const connection = yield* sql.reserve;
      const acquired = yield* Effect.acquireRelease(
        connection.executeRaw(`SELECT GET_LOCK(${LOCK_NAME}, ?) AS acquired`, [timeoutSeconds]),
        () => Effect.ignore(connection.executeRaw(`SELECT RELEASE_LOCK(${LOCK_NAME})`, [])),
      );
      const [row] = Array.isArray(acquired) ? acquired : [];
      const granted = typeof row === 'object' && row !== null && 'acquired' in row && Number(row.acquired) === 1;
      if (!granted) return yield* new MigrationError({ message: `Migration lock busy after ${timeoutSeconds}s` });
      return yield* effect;
    }),
  );

const objectExists = (object: SchemaObject) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const [row] =
      object.kind === 'table'
        ? yield* sql<{ present: number }>`SELECT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${object.table}) AS present`
        : object.kind === 'index'
          ? yield* sql<{ present: number }>`SELECT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${object.table} AND INDEX_NAME = ${object.index}) AS present`
          : yield* sql<{ present: number }>`SELECT EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${object.table} AND COLUMN_NAME = ${object.column}) AS present`;
    return Number(row?.present) === 1;
  });

export interface MigrationReport {
  readonly applied: ReadonlyArray<string>;
  readonly adopted: ReadonlyArray<string>;
}

const stepLabel = (migration: Migration, step: MigrationStep) =>
  `${migration.version}.${step.index} ${step.object.kind === 'table' ? step.object.table : `${step.object.table}.${step.object.kind === 'index' ? step.object.index : step.object.column}`}`;

function runStep(migration: Migration, step: MigrationStep, resumed: boolean, recorded: Map<number, string>, report: { applied: string[]; adopted: string[] }) {
  return Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const label = stepLabel(migration, step);
    const previous = recorded.get(step.index);
    if (previous !== undefined) {
      if (previous !== step.checksum) return yield* new MigrationError({ message: `Applied step ${label} was edited` });
      return;
    }
    const exists = yield* objectExists(step.object);
    if (exists && !resumed) return yield* new MigrationError({ message: `Step ${label} targets an object that already exists outside the ledger` });
    if (!exists) yield* sql.unsafe(step.sql);
    const outcome = exists ? 'adopted' : 'applied';
    yield* sql`INSERT INTO schema_migration_steps (version, step, checksum, outcome, recorded_at) VALUES (${migration.version}, ${step.index}, ${step.checksum}, ${outcome}, UTC_TIMESTAMP(6))`;
    report[outcome].push(label);
  });
}

function runMigration(migration: Migration, report: { applied: string[]; adopted: string[] }) {
  return Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const [ledger] = yield* sql<{ checksum: string; completed_at: string | null }>`SELECT checksum, completed_at FROM schema_migrations WHERE version = ${migration.version}`;
    if (ledger?.completed_at) {
      if (ledger.checksum !== migration.checksum) return yield* new MigrationError({ message: `Completed migration ${migration.version}_${migration.name} was edited` });
      return;
    }
    if (!ledger) {
      yield* sql`INSERT INTO schema_migrations (version, name, checksum, started_at) VALUES (${migration.version}, ${migration.name}, ${migration.checksum}, UTC_TIMESTAMP(6))`;
    }
    const steps = yield* sql<{ step: number; checksum: string }>`SELECT step, checksum FROM schema_migration_steps WHERE version = ${migration.version}`;
    const recorded = new Map(steps.map(row => [Number(row.step), row.checksum]));
    for (const step of migration.steps) yield* runStep(migration, step, ledger !== undefined, recorded, report);
    yield* sql`UPDATE schema_migrations SET checksum = ${migration.checksum}, completed_at = UTC_TIMESTAMP(6) WHERE version = ${migration.version}`;
  });
}

/** Applies pending migrations in version order; safe to rerun after any interruption. */
export const migrate = (migrations: ReadonlyArray<Migration>, lockTimeoutSeconds = 30) =>
  Effect.gen(function*() {
    yield* ensureLedger;
    const report = { applied: [] as string[], adopted: [] as string[] };
    yield* withMigrationLock(
      Effect.forEach(migrations, migration => runMigration(migration, report), { discard: true }),
      lockTimeoutSeconds,
    );
    return report satisfies MigrationReport;
  });

/** Pending migration versions; API readiness and worker startup refuse to run while any remain. */
export const pendingMigrations = (migrations: ReadonlyArray<Migration>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const [ledger] = yield* sql<{ present: number }>`SELECT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations') AS present`;
    const done = Number(ledger?.present) === 1 ? yield* sql<{ version: number }>`SELECT version FROM schema_migrations WHERE completed_at IS NOT NULL` : [];
    const completed = new Set(done.map(row => Number(row.version)));
    return migrations.filter(migration => !completed.has(migration.version)).map(migration => migration.version);
  });

export const requireCurrentSchema = (migrations: ReadonlyArray<Migration>) =>
  Effect.flatMap(pendingMigrations(migrations), pending =>
    pending.length === 0 ? Effect.void : new MigrationError({ message: `Schema is behind; pending migrations: ${pending.join(', ')}` }),
  );

if (import.meta.main) {
  Effect.gen(function*() {
    const config = yield* serverConfig;
    const report = yield* migrate(loadMigrations()).pipe(Effect.provide(dbLayer(config.mysql)));
    yield* Effect.logInfo('Migrations complete', report);
  }).pipe(NodeRuntime.runMain);
}
