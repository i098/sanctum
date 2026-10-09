/**
 * Better Auth organizations for self-hosting (sign-in plan B1). An organization belongs to one
 * Sanctum workspace: its id is the workspace id, linked in `workspace_orgs` under the embedded
 * issuer. Its members and roles become `workspace_members`, and its users human principals with a
 * `principal_identities` row; Sanctum's `workspace_members` stays the only input to authorization.
 * Additions and role changes apply after Better Auth commits, and sign-in applies them again in case
 * that failed. Removals apply first, so a failure leaves the person without Sanctum access, not with it.
 */
import { SqlClient } from '@effect/sql';
import type { WorkspaceId } from '@sanctum/contracts';
import { Data, Effect, Option } from 'effect';
import { identityPrincipal } from './auth.ts';
import { claimSeat, createHumanPrincipal, linkWorkspaceOrg, roleFromSlugs, setMembership, workspaceForOrg } from './store.ts';

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
 * organization changes nothing. Better Auth keeps a comma list of roles, mapped by `roleFromSlugs`.
 * A new person becomes a human principal with this identity. With `keepOwner` (joining, sign-in
 * repair), a person who already owns the workspace in Sanctum stays owner there and becomes owner
 * in the organization too; an explicit role change or removal always applies.
 */
export const applyMember = (issuer: string, org_id: string, user: IssuerUser, roles: string | null, keepOwner: boolean) =>
  Effect.gen(function* () {
    const workspace = yield* workspaceForOrg({ issuer, org_id });
    if (Option.isNone(workspace)) return;
    const known = yield* identityPrincipal({ issuer, subject: user.id });
    if (Option.isNone(known) && roles === null) return;
    const principal_id = Option.isSome(known) ? known.value : yield* createHumanPrincipal({ issuer, subject: user.id, name: user.name });
    let role = roles === null ? null : roleFromSlugs(roles.split(',').map(slug => slug.trim()));
    if (keepOwner && role !== null && role !== 'owner') {
      const sql = yield* SqlClient.SqlClient;
      const [owner] = yield* sql`SELECT 1 FROM workspace_members WHERE workspace_id = ${workspace.value} AND principal_id = ${principal_id} AND role = 'owner' AND revoked_at IS NULL`;
      if (owner !== undefined) {
        yield* sql`UPDATE auth_member SET role = 'owner' WHERE organizationId = ${org_id} AND userId = ${user.id}`;
        role = 'owner';
      }
    }
    yield* setMembership(issuer, workspace.value, principal_id, role);
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
      yield* applyMember(issuer, organizationId, user, role, true).pipe(
        Effect.catchTag('SeatLimitReached', error => Effect.logWarning('Organization member not added to Sanctum', { organizationId, reason: error.message })),
      );
    }
  });
