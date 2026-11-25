import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { PrincipalId, ProfileId, type MeetingId, type WorkspaceId } from '@sanctum/contracts';
import { ConfigProvider, Effect } from 'effect';
import { isDuplicate, isMissingReference, nextContextSeq } from '../src/db.ts';
import { now } from '../src/sql-dialect.ts';
import { addMember, bumpPermissionRevision, createProfile, grantMeetingAccess, reviseProfile } from '../src/store.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

const migrated = { migrated: true };

/** What an effect failed with: the constraint a database error broke, or the error's tag. */
const failure = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.map(error => (error._tag !== 'SqlError' ? error._tag : isDuplicate(error as never) ? 'duplicate' : isMissingReference(error as never) ? 'missing reference' : 'other')),
  );

const meeting = (workspace_id: WorkspaceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = randomUUID() as MeetingId;
    yield* sql`INSERT INTO meetings (id, workspace_id, state, timezone, started_at, processing, created_at, updated_at)
      VALUES (${id}, ${workspace_id}, 'active', 'UTC', ${now}, '{}', ${now}, ${now})`;
    return id;
  });

const human = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = PrincipalId.make(randomUUID());
    yield* sql`INSERT INTO principals (id, kind, display_name, created_at) VALUES (${id}, 'human', 'Person', ${now})`;
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
        yield* sql`UPDATE workspace_members SET revoked_at = ${now} WHERE principal_id = ${principal_id}`;
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

  it.effect('enforces the seat limit at membership activation; a workspace override beats the default', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [owner, , revoked] = yield* seedWorkspace('Acme', ['owner', 'agent', 'member']);
        const workspace_id = owner!.workspace_id;
        yield* sql`UPDATE workspace_members SET revoked_at = ${now} WHERE principal_id = ${revoked!.principal.id}`;
        // Owner holds 1 of 3 seats; agents and revoked members hold none. Concurrent adds cannot overshoot.
        const people = yield* Effect.all(Array.from({ length: 4 }, () => human()));
        const results = yield* Effect.all(people.map(principal_id => Effect.either(addMember({ workspace_id, principal_id, role: 'member' }))), { concurrency: 4 });
        const refused = results.filter(result => result._tag === 'Left').map(result => result.left);
        expect(refused).toHaveLength(2);
        expect(refused[0]).toMatchObject({ _tag: 'SeatLimitReached', limit: 3, message: 'Workspace seat limit of 3 reached' });
        // A seat holder may change role at the limit; agents need no seat; reactivation needs one.
        expect(yield* addMember({ workspace_id, principal_id: owner!.principal.id, role: 'admin' })).toBeGreaterThan(1);
        yield* addMember({ workspace_id, principal_id: yield* human(), role: 'agent' });
        expect((yield* Effect.flip(addMember({ workspace_id, principal_id: revoked!.principal.id, role: 'member' })))._tag).toBe('SeatLimitReached');
        // The workspace's own limit overrides the default.
        yield* sql`UPDATE workspaces SET seat_limit = 4 WHERE id = ${workspace_id}`;
        yield* addMember({ workspace_id, principal_id: revoked!.principal.id, role: 'member' });
        expect(yield* Effect.flip(addMember({ workspace_id, principal_id: yield* human(), role: 'admin' }))).toMatchObject({ _tag: 'SeatLimitReached', limit: 4 });
      }).pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map([['SANCTUM_DEFAULT_SEAT_LIMIT', '3']])))),
      migrated,
    ),
  );

  it.effect('has no seat limit when the default is unset; a workspace limit still applies', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [owner] = yield* seedWorkspace('Acme');
        const workspace_id = owner!.workspace_id;
        const people = yield* Effect.all(Array.from({ length: 7 }, () => human()));
        yield* Effect.forEach(people, principal_id => addMember({ workspace_id, principal_id, role: 'member' }));
        yield* sql`UPDATE workspaces SET seat_limit = 8 WHERE id = ${workspace_id}`;
        expect(yield* Effect.flip(addMember({ workspace_id, principal_id: yield* human(), role: 'member' }))).toMatchObject({ _tag: 'SeatLimitReached', limit: 8 });
        // The counter bump reads the workspace before the commit would break the foreign key.
        expect(yield* Effect.flip(addMember({ workspace_id: randomUUID() as WorkspaceId, principal_id: yield* human(), role: 'member' }))).toMatchObject({ _tag: 'SqlError', message: expect.stringContaining('Unknown workspace') });
      }).pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map()))),
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
        expect(yield* failure(crossGrant)).toBe('missing reference');
        const crossProfile = createProfile(beta!.workspace_id, { kind: 'person', principal_id: alpha!.principal.id, display_name: 'Ana', details: {} });
        expect(yield* failure(crossProfile)).toBe('missing reference');
        // Semantic matching records follow their profile's workspace too.
        const profile = yield* createProfile(alpha!.workspace_id, { kind: 'person', principal_id: null, display_name: 'Ana', details: {} });
        const embed = (workspace_id: WorkspaceId) =>
          sql`INSERT INTO profile_embeddings (workspace_id, profile_id, kind, model, dimension, embedding, source_revision, created_at)
            VALUES (${workspace_id}, ${profile}, 'profile', 'fixture-model', 1, ${Buffer.alloc(4, 1)}, 1, ${now})`;
        expect(yield* failure(embed(beta!.workspace_id))).toBe('missing reference');
        yield* embed(alpha!.workspace_id);
        // Nothing of the failed statements was left behind, and the counter is untouched.
        const [counts] = yield* sql<{ grants: number; revision: number }>`SELECT
          (SELECT COUNT(*) FROM meeting_access) AS grants, (SELECT permission_revision FROM workspaces WHERE id = ${beta!.workspace_id}) AS revision`;
        expect(counts).toEqual({ grants: 0, revision: 1 });
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
            yield* sql`INSERT INTO principals (id, kind, display_name, created_at) VALUES (${principal}, 'agent', 'Bot', ${now})`;
            yield* addMember({ workspace_id: owner!.workspace_id, principal_id: principal, role: 'agent' });
            yield* addMember({ workspace_id: owner!.workspace_id, principal_id: principal, role: 'agent' });
            // Duplicate primary key: the whole unit of work must disappear.
            yield* sql`INSERT INTO principals (id, kind, display_name, created_at) VALUES (${principal}, 'agent', 'Bot', ${now})`;
          }),
        );
        expect(yield* failure(transaction)).toBe('duplicate');
        const rows = yield* sql`SELECT id FROM principals WHERE id = ${principal}`;
        const [workspace] = yield* sql<{ permission_revision: number }>`SELECT permission_revision FROM workspaces WHERE id = ${owner!.workspace_id}`;
        expect(rows).toEqual([]);
        expect(workspace!.permission_revision).toBe(1);
      }),
      migrated,
    ),
  );
});
