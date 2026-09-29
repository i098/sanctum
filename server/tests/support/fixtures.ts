/** Synthetic workspaces, principals and access scopes; never copied from real data. */
import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { type AccessScope, type AccessScopeName, PrincipalId, WorkspaceId, type WorkspaceRole } from '@sanctum/contracts';
import { Effect } from 'effect';

const ALL_SCOPES: ReadonlyArray<AccessScopeName> = ['context:read', 'context:write', 'recordings:read', 'actions:request', 'actions:execute', 'workspace:admin'];

/** Access scope as the kernel's authenticator would resolve it, for tests of domain functions. */
export function fixtureAccess(overrides: Partial<AccessScope> = {}): AccessScope {
  return {
    workspace_id: WorkspaceId.make(randomUUID()),
    principal: { id: PrincipalId.make(randomUUID()), kind: 'human', display_name: 'Fixture Person' },
    role: 'member',
    scopes: ALL_SCOPES,
    meetings: { kind: 'accessible' },
    permission_revision: 1,
    ...overrides,
  };
}

/** Inserts a workspace with one member per role given and returns their access scopes. */
export const seedWorkspace = (name: string, roles: ReadonlyArray<WorkspaceRole> = ['owner']) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const workspace_id = WorkspaceId.make(randomUUID());
    yield* sql`INSERT INTO workspaces (id, name, timezone, created_at) VALUES (${workspace_id}, ${name}, 'America/Los_Angeles', UTC_TIMESTAMP(6))`;
    return yield* Effect.forEach(roles, role =>
      Effect.gen(function* () {
        const access = fixtureAccess({ workspace_id, role });
        const kind = role === 'agent' || role === 'device' ? role : 'human';
        yield* sql`INSERT INTO principals (id, kind, display_name, created_at) VALUES (${access.principal.id}, ${kind}, ${`${name} ${role}`}, UTC_TIMESTAMP(6))`;
        yield* sql`INSERT INTO workspace_members (workspace_id, principal_id, role, created_at) VALUES (${workspace_id}, ${access.principal.id}, ${role}, UTC_TIMESTAMP(6))`;
        return { ...access, principal: { ...access.principal, kind } } satisfies AccessScope;
      }),
    );
  });
