/**
 * Better Auth organizations for self-hosting (sign-in plan B1). An organization belongs to one
 * Sanctum workspace: its id is the workspace id, linked in `workspace_orgs` under the embedded
 * issuer. Its members and roles become `workspace_members`, and its users human principals with a
 * `principal_identities` row; Sanctum's `workspace_members` stays the only input to authorization.
 * Additions and role changes apply after Better Auth commits, and sign-in applies them again in case
 * that failed. Removals apply first, so a failure leaves the person without Sanctum access, not with it.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { PrincipalId, type WorkspaceId, type WorkspaceRole } from '@sanctum/contracts';
import { Data, Effect, Option } from 'effect';
import { identityPrincipal, linkIdentity } from './auth.ts';
import { claimSeat, linkWorkspaceOrg, setMembership, workspaceForOrg } from './store.ts';

/** A Better Auth user; its id is the `sub` of its ID and access tokens. */
export interface IssuerUser {
  readonly id: string;
  readonly name: string;
}

class OrganizationRefused extends Data.TaggedError('OrganizationRefused')<{ readonly message: string }> {}

/**
 * `beforeCreateOrganization`: the slug names the workspace, and only an active owner of it may create
 * its organization. The link is written first, so a retry after a failed creation finds the same one.
 */
export const workspaceOrganization = (issuer: string, slug: string | undefined, user: IssuerUser) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const principal = yield* identityPrincipal({ issuer, subject: user.id });
    const [workspace] =
      Option.isNone(principal) || slug === undefined
        ? []
        : yield* sql<{ id: WorkspaceId; name: string }>`SELECT w.id, w.name FROM workspaces w
            JOIN workspace_members m ON m.workspace_id = w.id AND m.principal_id = ${principal.value} AND m.role = 'owner' AND m.revoked_at IS NULL
            WHERE w.id = ${slug}`;
    if (workspace === undefined) return yield* new OrganizationRefused({ message: 'Only an owner of this Sanctum workspace can set up its team' });
    yield* linkWorkspaceOrg({ workspace_id: workspace.id, issuer, org_id: workspace.id });
    return workspace;
  });

/**
 * Applies one person's organization role (null: removed) to the linked workspace; an unlinked
 * organization changes nothing. Better Auth keeps a comma list of roles: `owner` and `admin` map one
 * to one, anything else is `member`. A new person becomes a human principal with this identity.
 */
export const applyMember = (issuer: string, org_id: string, user: IssuerUser, roles: string | null) =>
  Effect.gen(function* () {
    const workspace = yield* workspaceForOrg({ issuer, org_id });
    if (Option.isNone(workspace)) return;
    const known = yield* identityPrincipal({ issuer, subject: user.id });
    if (Option.isNone(known) && roles === null) return;
    const principal_id = Option.getOrElse(known, () => PrincipalId.make(randomUUID()));
    if (Option.isNone(known)) {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.zipRight(
          sql`INSERT INTO principals (id, kind, display_name, created_at) VALUES (${principal_id}, 'human', ${user.name.trim().slice(0, 200) || user.id}, UTC_TIMESTAMP(6))`,
          linkIdentity({ issuer, subject: user.id, principal_id }),
        ),
      );
    }
    const held = roles?.split(',').map(role => role.trim());
    const role: WorkspaceRole | null = held === undefined ? null : held.includes('owner') ? 'owner' : held.includes('admin') ? 'admin' : 'member';
    yield* setMembership(workspace.value, principal_id, role);
  });

/** `beforeAcceptInvitation`: a full linked workspace refuses, so Better Auth adds no member that Sanctum would refuse. */
export const requireSeat = (issuer: string, org_id: string, user: IssuerUser) =>
  Effect.gen(function* () {
    const workspace = yield* workspaceForOrg({ issuer, org_id });
    if (Option.isNone(workspace)) return;
    const principal = yield* identityPrincipal({ issuer, subject: user.id });
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(claimSeat(workspace.value, Option.getOrNull(principal)));
  });

/**
 * Sign-in repair: applies every organization membership of the user again, in case a hook failed
 * after Better Auth committed. A full workspace is skipped with a warning; the others still apply.
 */
export const reconcileMember = (issuer: string, user: IssuerUser) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const memberships = yield* sql<{ organizationId: string; role: string }>`SELECT organizationId, role FROM auth_member WHERE userId = ${user.id}`;
    for (const { organizationId, role } of memberships) {
      yield* applyMember(issuer, organizationId, user, role).pipe(
        Effect.catchTag('SeatLimitReached', error => Effect.logWarning('Organization member not added to Sanctum', { organizationId, reason: error.message })),
      );
    }
  });
