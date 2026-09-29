import { randomUUID } from 'node:crypto';
import { SqlClient, type SqlError, SqlSchema } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Schema } from 'effect';
import { DbBool, DbJson, DbSafeInt, DbSha256, DbUtc, ER_CHECK_CONSTRAINT_VIOLATED, ER_DUP_ENTRY, ER_NO_REFERENCED_ROW, mysqlErrno, verifyUtcSession } from '../src/db.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

const errnoOf = <A>(effect: Effect.Effect<A, SqlError.SqlError, SqlClient.SqlClient>) =>
  Effect.map(Effect.flip(effect), mysqlErrno);

const Row = Schema.Struct({
  created_at: DbUtc,
  context_seq: DbSafeInt,
  capture_policy: Schema.NullOr(DbJson(Schema.Struct({ note: Schema.String, nested: Schema.NullOr(Schema.Array(Schema.Number)) }))),
  name: Schema.String,
});

describe('database boundary', () => {
  it.effect('round-trips UTC microseconds, BIGINT, JSON and Unicode through one decoding boundary', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* verifyUtcSession;
        const id = randomUUID();
        const name = 'Café 会議 🎙️ Ωmega';
        const policy = { note: 'straße ✓', nested: null };
        yield* sql`INSERT INTO workspaces (id, name, timezone, context_seq, capture_policy, created_at)
          VALUES (${id}, ${name}, 'Europe/Berlin', ${String(Number.MAX_SAFE_INTEGER)}, ${JSON.stringify(policy)}, ${'2026-03-29 01:59:59.999999'})`;
        const find = SqlSchema.single({ Request: Schema.String, Result: Row, execute: key => sql`SELECT created_at, context_seq, capture_policy, name FROM workspaces WHERE id = ${key}` });
        const row = yield* find(id);
        expect(row).toEqual({ created_at: '2026-03-29T01:59:59.999999Z', context_seq: Number.MAX_SAFE_INTEGER, capture_policy: policy, name });
        yield* sql`UPDATE workspaces SET context_seq = context_seq + 1 WHERE id = ${id}`;
        const unsafe = yield* Effect.exit(find(id));
        expect(Exit.isFailure(unsafe) && String(unsafe.cause)).toMatch(/not a safe integer/);
      }),
      { migrated: true },
    ),
  );

  it('column schemas encode back to MySQL representations', () => {
    expect(Schema.encodeSync(DbUtc)(Schema.decodeSync(DbUtc)('2026-09-26 17:08:16.000100'))).toBe('2026-09-26 17:08:16.000100');
    expect(() => Schema.decodeUnknownSync(DbUtc)('2026-09-26T17:08:16Z')).toThrow();
    expect(Schema.decodeSync(DbBool)(1)).toBe(true);
    expect(Schema.encodeSync(DbBool)(false)).toBe(0);
    expect(Schema.decodeUnknownSync(DbSafeInt)('-42')).toBe(-42);
    expect(() => Schema.decodeUnknownSync(DbSafeInt)('1.5')).toThrow();
    const hash = 'ab'.repeat(32);
    expect(Schema.decodeSync(DbSha256)(Schema.encodeSync(DbSha256)(hash))).toBe(hash);
    expect(Schema.decodeUnknownSync(DbJson(Schema.Array(Schema.Number)))('[1,2]')).toEqual([1, 2]);
  });

  it.effect('refuses a non-UTC session', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const exit = yield* Effect.exit(sql.withTransaction(Effect.zipRight(sql`SET time_zone = '+02:00'`, verifyUtcSession)));
        expect(Exit.isFailure(exit) && String(exit.cause)).toMatch(/must be UTC/);
      }),
    ),
  );
});

describe('schema constraints', () => {
  it.effect('composite keys stop rows pointing into another workspace', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [alpha] = yield* seedWorkspace('Alpha');
        const [beta] = yield* seedWorkspace('Beta');
        const meeting = randomUUID();
        yield* sql`INSERT INTO meetings (id, workspace_id, state, timezone, started_at, processing, created_at, updated_at)
          VALUES (${meeting}, ${alpha!.workspace_id}, 'active', 'UTC', UTC_TIMESTAMP(6), '{}', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
        const crossed = yield* errnoOf(sql`INSERT INTO meeting_access (workspace_id, meeting_id, principal_id, access, granted_by, created_at)
          VALUES (${beta!.workspace_id}, ${meeting}, ${beta!.principal.id}, 'read', ${beta!.principal.id}, UTC_TIMESTAMP(6))`);
        expect(crossed).toBe(ER_NO_REFERENCED_ROW);
        const foreignMember = yield* errnoOf(sql`INSERT INTO meeting_access (workspace_id, meeting_id, principal_id, access, granted_by, created_at)
          VALUES (${alpha!.workspace_id}, ${meeting}, ${beta!.principal.id}, 'read', ${alpha!.principal.id}, UTC_TIMESTAMP(6))`);
        expect(foreignMember).toBe(ER_NO_REFERENCED_ROW);
      }),
      { migrated: true },
    ),
  );

  it.effect('recording chunks have one source identity and a valid WAV size', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [device] = yield* seedWorkspace('Room', ['device']);
        const ws = device!.workspace_id;
        const listener = randomUUID();
        const epoch = randomUUID();
        yield* sql`INSERT INTO listeners (id, workspace_id, principal_id, name, mode, capabilities, created_at)
          VALUES (${listener}, ${ws}, ${device!.principal.id}, 'Room 1', 'room', '{}', UTC_TIMESTAMP(6))`;
        yield* sql`INSERT INTO capture_epochs (id, workspace_id, listener_id, lease_generation, sample_rate, channels, encoding, sample_start, captured_at, timezone, start_reason, started_at, live_sample_end)
          VALUES (${epoch}, ${ws}, ${listener}, 1, 48000, 1, 'pcm_s16le', 0, UTC_TIMESTAMP(6), 'UTC', 'start', UTC_TIMESTAMP(6), 0)`;
        const chunk = (sequence: number, byteLength: number) =>
          sql`INSERT INTO recording_chunks (id, workspace_id, listener_id, epoch_id, track, sequence, sample_start, sample_count, sample_rate, captured_at, byte_length, sha256, object_key, upload_state, created_at)
            VALUES (${randomUUID()}, ${ws}, ${listener}, ${epoch}, 0, ${sequence}, ${sequence * 1_440_000}, 1440000, 48000, UTC_TIMESTAMP(6), ${byteLength}, ${Buffer.alloc(32)}, ${`${epoch}/${sequence}-${byteLength}`}, 'pending', UTC_TIMESTAMP(6))`;
        yield* chunk(0, 44 + 1_440_000 * 2);
        expect(yield* errnoOf(chunk(0, 44 + 1_440_000 * 2))).toBe(ER_DUP_ENTRY);
        expect(yield* errnoOf(chunk(1, 1_000))).toBe(ER_CHECK_CONSTRAINT_VIOLATED);
      }),
      { migrated: true },
    ),
  );

  it.effect('allows one active job per work key while keeping finished history', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [owner] = yield* seedWorkspace('Jobs');
        const enqueue = (id: string) =>
          sql`INSERT INTO jobs (id, workspace_id, kind, work_key, status, payload, available_at, max_attempts, created_at, updated_at)
            VALUES (${id}, ${owner!.workspace_id}, 'context.refresh', 'meeting:1', 'pending', '{}', UTC_TIMESTAMP(6), 3, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
        const first = randomUUID();
        yield* enqueue(first);
        expect(yield* errnoOf(enqueue(randomUUID()))).toBe(ER_DUP_ENTRY);
        yield* sql`UPDATE jobs SET status = 'succeeded' WHERE id = ${first}`;
        yield* enqueue(randomUUID());
        const [count] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM jobs`;
        expect(Number(count!.total)).toBe(2);
      }),
      { migrated: true },
    ),
  );

  it.effect('treats identifiers and idempotency keys case-sensitively', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [agent] = yield* seedWorkspace('Keys', ['agent']);
        const add = (key: string) =>
          sql`INSERT INTO context_items (id, revision, workspace_id, kind, text, state, derivation, sources, author_type, author_principal_id, idempotency_key, payload_sha256, created_at)
            VALUES (${randomUUID()}, 1, ${agent!.workspace_id}, 'decision', 'x', 'provisional', 'spoken', '[]', 'agent', ${agent!.principal.id}, ${key}, ${Buffer.alloc(32)}, UTC_TIMESTAMP(6))`;
        yield* add('Run-1');
        yield* add('run-1');
        expect(yield* errnoOf(add('Run-1'))).toBe(ER_DUP_ENTRY);
      }),
      { migrated: true },
    ),
  );
});
