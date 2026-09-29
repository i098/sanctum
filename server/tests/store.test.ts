import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { PrincipalId, ProfileId, type MeetingId, type WorkspaceId } from '@sanctum/contracts';
import { Effect } from 'effect';
import { ER_DUP_ENTRY, ER_NO_REFERENCED_ROW, mysqlErrno } from '../src/db.ts';
import { addMember, bumpPermissionRevision, createProfile, grantMeetingAccess, nextContextSeq, reviseProfile } from '../src/store.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

const migrated = { migrated: true };

const errno = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(Effect.map(error => (error._tag === 'SqlError' ? mysqlErrno(error as never) : error._tag)));

const meeting = (workspace_id: WorkspaceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = randomUUID() as MeetingId;
    yield* sql`INSERT INTO meetings (id, workspace_id, state, timezone, started_at, processing, created_at, updated_at)
      VALUES (${id}, ${workspace_id}, 'active', 'UTC', UTC_TIMESTAMP(6), '{}', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    return id;
  });

describe('store', () => {
  it.effect('allocates context sequence numbers per workspace in committed order', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [alpha] = yield* seedWorkspace('Acme');
        const [beta] = yield* seedWorkspace('Acme');
        const allocated = yield* Effect.all(
          Array.from({ length: 8 }, () => sql.withTransaction(nextContextSeq(alpha!.workspace_id))),
          { concurrency: 4 },
        );
        expect([...allocated].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(yield* nextContextSeq(beta!.workspace_id)).toBe(1);
        // A rolled-back change releases nothing: its number is never observed as committed.
        yield* Effect.exit(sql.withTransaction(Effect.zipRight(nextContextSeq(alpha!.workspace_id), Effect.fail('abort'))));
        expect(yield* nextContextSeq(alpha!.workspace_id)).toBe(9);
      }),
      migrated,
    ),
  );

  it.effect('upserts membership and meeting grants, bumping the permission revision each time', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [owner, member] = yield* seedWorkspace('Acme', ['owner', 'member']);
        const workspace_id = owner!.workspace_id;
        const principal_id = member!.principal.id;
        yield* sql`UPDATE workspace_members SET revoked_at = UTC_TIMESTAMP(6) WHERE principal_id = ${principal_id}`;
        expect(yield* addMember({ workspace_id, principal_id, role: 'admin' })).toBe(2);
        const [row] = yield* sql<{ role: string; revoked_at: string | null }>`SELECT role, revoked_at FROM workspace_members
          WHERE workspace_id = ${workspace_id} AND principal_id = ${principal_id}`;
        expect(row).toEqual({ role: 'admin', revoked_at: null });

        const meeting_id = yield* meeting(workspace_id);
        const grant = { workspace_id, meeting_id, principal_id, granted_by: owner!.principal.id };
        expect(yield* grantMeetingAccess({ ...grant, access: 'read' })).toBe(3);
        expect(yield* grantMeetingAccess({ ...grant, access: 'write' })).toBe(4);
        const grants = yield* sql<{ access: string }>`SELECT access FROM meeting_access WHERE meeting_id = ${meeting_id}`;
        expect(grants).toEqual([{ access: 'write' }]);
        expect(yield* bumpPermissionRevision(workspace_id)).toBe(5);
      }),
      migrated,
    ),
  );

  it.effect('refuses grants and profiles that point into another workspace', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [alpha] = yield* seedWorkspace('Acme');
        const [beta] = yield* seedWorkspace('Acme');
        const meeting_id = yield* meeting(alpha!.workspace_id);
        const crossGrant = grantMeetingAccess({
          workspace_id: beta!.workspace_id,
          meeting_id,
          principal_id: beta!.principal.id,
          access: 'read',
          granted_by: beta!.principal.id,
        });
        expect(yield* errno(crossGrant)).toBe(ER_NO_REFERENCED_ROW);
        const crossProfile = createProfile(beta!.workspace_id, { kind: 'person', principal_id: alpha!.principal.id, display_name: 'Ana', details: {} });
        expect(yield* errno(crossProfile)).toBe(ER_NO_REFERENCED_ROW);
        // Semantic matching records follow their profile's workspace too.
        const profile = yield* createProfile(alpha!.workspace_id, { kind: 'person', principal_id: null, display_name: 'Ana', details: {} });
        const embed = (workspace_id: WorkspaceId) =>
          sql`INSERT INTO profile_embeddings (workspace_id, profile_id, kind, model, dimension, embedding, source_revision, created_at)
            VALUES (${workspace_id}, ${profile}, 'profile', 'fixture-model', 1, ${Buffer.alloc(4, 1)}, 1, UTC_TIMESTAMP(6))`;
        expect(yield* errno(embed(beta!.workspace_id))).toBe(ER_NO_REFERENCED_ROW);
        yield* embed(alpha!.workspace_id);
        // Nothing of the failed statements was left behind, and the counter is untouched.
        const [counts] = yield* sql<{ grants: number; revision: string }>`SELECT
          (SELECT COUNT(*) FROM meeting_access) AS grants, (SELECT permission_revision FROM workspaces WHERE id = ${beta!.workspace_id}) AS revision`;
        expect({ grants: Number(counts!.grants), revision: counts!.revision }).toEqual({ grants: 0, revision: '1' });
      }),
      migrated,
    ),
  );

  it.effect('revision-checks profile edits and isolates them by workspace', () =>
    withDatabase(
      Effect.gen(function* () {
        const [alpha] = yield* seedWorkspace('Acme');
        const [beta] = yield* seedWorkspace('Acme');
        const id = yield* createProfile(alpha!.workspace_id, { kind: 'person', principal_id: alpha!.principal.id, display_name: 'Ana', details: {} });
        const edit = (expected_revision: number, display_name: string) =>
          reviseProfile(alpha!.workspace_id, { id, expected_revision, display_name, details: { note: 'Ω' } });
        expect(yield* edit(1, 'Ana Díaz')).toBe(2);
        const stale = yield* Effect.flip(edit(1, 'Overwrite'));
        expect(stale).toMatchObject({ _tag: 'RevisionConflict', current_revision: 2 });
        const foreign = yield* Effect.flip(reviseProfile(beta!.workspace_id, { id, expected_revision: 2, display_name: 'x', details: {} }));
        expect(foreign._tag).toBe('NotFound');
        const missing = yield* Effect.flip(reviseProfile(alpha!.workspace_id, { id: ProfileId.make(randomUUID()), expected_revision: 1, display_name: 'x', details: {} }));
        expect(missing._tag).toBe('NotFound');
        expect(yield* edit(2, 'Ana D.')).toBe(3);
      }),
      migrated,
    ),
  );

  it.effect('rolls back every statement of a failed transaction', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [owner] = yield* seedWorkspace('Acme');
        const principal = PrincipalId.make(randomUUID());
        const transaction = sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO principals (id, kind, display_name, created_at) VALUES (${principal}, 'agent', 'Bot', UTC_TIMESTAMP(6))`;
            yield* addMember({ workspace_id: owner!.workspace_id, principal_id: principal, role: 'agent' });
            yield* addMember({ workspace_id: owner!.workspace_id, principal_id: principal, role: 'agent' });
            // Duplicate primary key: the whole unit of work must disappear.
            yield* sql`INSERT INTO principals (id, kind, display_name, created_at) VALUES (${principal}, 'agent', 'Bot', UTC_TIMESTAMP(6))`;
          }),
        );
        expect(yield* errno(transaction)).toBe(ER_DUP_ENTRY);
        const rows = yield* sql`SELECT id FROM principals WHERE id = ${principal}`;
        const [workspace] = yield* sql<{ permission_revision: string }>`SELECT permission_revision FROM workspaces WHERE id = ${owner!.workspace_id}`;
        expect(rows).toEqual([]);
        expect(workspace!.permission_revision).toBe('1');
      }),
      migrated,
    ),
  );
});
