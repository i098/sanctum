/**
 * WorkOS Organizations glue for the hosted site (sign-in plan W1). An organization linked in
 * `workspace_orgs` is a Sanctum workspace, its memberships and roles are `workspace_members`, and
 * a WorkOS user is a human principal with a `principal_identities` row under the AuthKit issuer.
 * WorkOS is the source for adding, removing and changing members of linked workspaces; Sanctum's
 * `workspace_members` stays the only input to authorization, and an unlinked workspace is never
 * touched. Sign-in reconciles the user (an accepted invitation becomes a member there), the
 * `workos.sync` job follows the Events API, and self-serve creates an organization with its workspace.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient, SqlSchema } from '@effect/sql';
import { JobFailure, PrincipalId, WorkspaceId, WorkspaceRole } from '@sanctum/contracts';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { identityPrincipal, linkIdentity } from './auth.ts';
import { engineeringDefaults, serverConfig } from './config.ts';
import { DbSafeInt } from './db.ts';
import type { JobHandler } from './job-types.ts';
import { enqueueJob } from './jobs.ts';
import { makeWorkosClient, type OrganizationMembership, PAGE_LIMIT, type WorkosClient, type WorkosEvent, type WorkosOptions } from './providers/workos.ts';
import { addMember, bumpPermissionRevision, linkWorkspaceOrg, workspaceForOrg } from './store.ts';

interface WorkosOrganizationSettings {
  readonly client: WorkosClient;
  /** The AuthKit issuer (`SANCTUM_OIDC_ISSUER`): the `iss` of WorkOS identities and organization links. */
  readonly issuer: string;
  readonly selfServe: boolean;
}

/** None unless `WORKOS_API_KEY` and `SANCTUM_OIDC_ISSUER` are both set. */
export class WorkosOrganizations extends Context.Tag('sanctum/WorkosOrganizations')<WorkosOrganizations, Option.Option<WorkosOrganizationSettings>>() {}

/** Settings over a WorkOS client; `WorkosOrganizationsFromEnv` reads them from the environment, and tests pass a fake `fetch`. */
export const workosSettings = ({ issuer, selfServe, ...client }: WorkosOptions & { readonly issuer: string; readonly selfServe: boolean }): WorkosOrganizationSettings => ({
  client: makeWorkosClient(client),
  issuer,
  selfServe,
});

export const WorkosOrganizationsFromEnv = Layer.effect(
  WorkosOrganizations,
  Effect.map(serverConfig, ({ workos, signIn }) =>
    Option.map(Option.all({ apiKey: workos.apiKey, issuer: signIn.issuer }), ({ apiKey, issuer }) =>
      workosSettings({ apiKey, issuer, selfServe: workos.selfServeWorkspaces, timeoutMs: engineeringDefaults.workosSync.requestTimeoutMs }),
    ),
  ),
);

/** Name and IANA time zone of a requested self-serve workspace; a flow cookie carries it, so the callback decodes it again. */
export const SelfServeRequest = Schema.Struct({
  name: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(200)),
  timezone: Schema.String.pipe(
    Schema.filter(zone => {
      try {
        return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone !== undefined;
      } catch {
        return false;
      }
    }, { message: () => 'Unknown IANA time zone' }),
  ),
});
export type SelfServeRequest = typeof SelfServeRequest.Type;

type Identity = { readonly issuer: string; readonly subject: string };

/**
 * Sanctum role of a WorkOS membership: null unless it is active; the slugs `owner` and `admin` map
 * one to one, and any other slug (`member` or a custom role) is a plain member.
 */
const roleOf = (membership: OrganizationMembership): WorkspaceRole | null => {
  const slug = membership.role?.slug;
  if (membership.status !== 'active') return null;
  return slug === 'owner' || slug === 'admin' ? slug : 'member';
};

/**
 * Moves one membership to `role`, or revokes it for null; no write when it already matches, so a
 * repeated sign-in does not invalidate caches. A seat over the workspace limit is refused and logged.
 */
const setMembership = (workspace_id: WorkspaceId, principal_id: PrincipalId, role: WorkspaceRole | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const current = yield* SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ role: WorkspaceRole, active: DbSafeInt }),
      execute: () => sql`SELECT role, revoked_at IS NULL AS active FROM workspace_members WHERE workspace_id = ${workspace_id} AND principal_id = ${principal_id}`,
    })(undefined).pipe(Effect.orDie);
    const active = Option.filter(current, row => row.active === 1);
    if (role === null) {
      if (Option.isNone(active)) return;
      yield* sql.withTransaction(
        Effect.zipRight(
          sql`UPDATE workspace_members SET revoked_at = UTC_TIMESTAMP(6) WHERE workspace_id = ${workspace_id} AND principal_id = ${principal_id} AND revoked_at IS NULL`,
          bumpPermissionRevision(workspace_id),
        ),
      );
      return;
    }
    if (Option.isSome(active) && active.value.role === role) return;
    yield* addMember({ workspace_id, principal_id, role }).pipe(
      Effect.catchTag('SeatLimitReached', error => Effect.logWarning('WorkOS member not added to Sanctum', { workspace_id, principal_id, reason: error.message })),
    );
  });

/** Active memberships of the principal in workspaces linked under `issuer`. */
const linkedMemberships = (issuer: string, principal_id: PrincipalId) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    sql<{ workspace_id: WorkspaceId }>`SELECT m.workspace_id FROM workspace_members m
      JOIN workspace_orgs o ON o.workspace_id = m.workspace_id AND o.issuer = ${issuer}
      WHERE m.principal_id = ${principal_id} AND m.revoked_at IS NULL`,
  );

/**
 * Sign-in hook: applies the user's WorkOS memberships to the linked workspaces (creating the human
 * principal and identity on the first active one) and revokes linked memberships WorkOS no longer
 * lists as active. A self-serve request then creates a workspace when the user still has no membership.
 */
export const reconcileSignIn = (identity: Identity, name: string | null, create: SelfServeRequest | undefined) =>
  Effect.gen(function* () {
    const settings = yield* WorkosOrganizations;
    if (Option.isNone(settings) || identity.issuer !== settings.value.issuer) return;
    yield* reconcileMemberships(settings.value, identity, name);
    if (create === undefined || !settings.value.selfServe) return;
    const sql = yield* SqlClient.SqlClient;
    const principal = yield* identityPrincipal(identity);
    const [held] = Option.isNone(principal) ? [] : yield* sql`SELECT 1 FROM workspace_members WHERE principal_id = ${principal.value} AND revoked_at IS NULL LIMIT 1`;
    if (held === undefined) yield* createSelfServeWorkspace(settings.value, identity, name, create);
  });

const reconcileMemberships = ({ client, issuer }: WorkosOrganizationSettings, identity: Identity, name: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const memberships = yield* client.listMemberships(identity.subject);
    const orgIds = memberships.map(membership => membership.organization_id);
    const links = orgIds.length === 0 ? [] : yield* sql<{ org_id: string; workspace_id: WorkspaceId }>`SELECT org_id, workspace_id FROM workspace_orgs
      WHERE issuer = ${issuer} AND org_id IN ${sql.in(orgIds)}`;
    const desired = new Map(links.map(link => [link.workspace_id, roleOf(memberships.find(membership => membership.organization_id === link.org_id)!)]));
    let principal = yield* identityPrincipal(identity);
    if (Option.isSome(principal)) {
      for (const held of yield* linkedMemberships(issuer, principal.value)) if (!desired.has(held.workspace_id)) desired.set(held.workspace_id, null);
    } else if ([...desired.values()].some(role => role !== null)) {
      const principal_id = PrincipalId.make(randomUUID());
      yield* sql.withTransaction(
        Effect.zipRight(
          sql`INSERT INTO principals (id, kind, display_name, created_at) VALUES (${principal_id}, 'human', ${name?.trim().slice(0, 200) || identity.subject}, UTC_TIMESTAMP(6))`,
          linkIdentity({ ...identity, principal_id }),
        ),
      );
      principal = Option.some(principal_id);
    }
    if (Option.isNone(principal)) return;
    for (const [workspace_id, role] of desired) yield* setMembership(workspace_id, principal.value, role);
  });

/**
 * Idempotent per WorkOS user: the organization carries `external_id` `sanctum-self-serve:<user>`, the
 * owner membership is created only when missing, and the workspace only while that organization has
 * no link; the owner membership itself comes from reconciliation. A retry after any failed step
 * resumes without a second organization or workspace. The workspace keeps the default seat limit.
 */
const createSelfServeWorkspace = (settings: WorkosOrganizationSettings, identity: Identity, name: string | null, request: SelfServeRequest) =>
  Effect.gen(function* () {
    const { client, issuer } = settings;
    const sql = yield* SqlClient.SqlClient;
    const external_id = `sanctum-self-serve:${identity.subject}`;
    const found = yield* client.organizationByExternalId(external_id);
    const organization = Option.isSome(found) ? found.value : yield* client.createOrganization({ name: request.name, external_id });
    const memberships = yield* client.listMemberships(identity.subject);
    if (!memberships.some(membership => membership.organization_id === organization.id && membership.status === 'active')) {
      yield* client.createMembership({ user_id: identity.subject, organization_id: organization.id, role_slug: 'owner' });
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (Option.isSome(yield* workspaceForOrg({ issuer, org_id: organization.id }))) return;
        const workspace_id = WorkspaceId.make(randomUUID());
        yield* sql`INSERT INTO workspaces (id, name, timezone, created_at) VALUES (${workspace_id}, ${organization.name.slice(0, 200)}, ${request.timezone}, UTC_TIMESTAMP(6))`;
        yield* linkWorkspaceOrg({ workspace_id, issuer, org_id: organization.id });
        yield* armWorkosSync;
      }),
    );
    yield* reconcileMemberships(settings, identity, name);
  });

const SYNC_CURSOR = 'workos.events';
const SYNC_KEY = 'events';

/**
 * Ensures the `workos.sync` job is scheduled. The WorkOS event feed is one per environment, but a
 * ledger row belongs to a workspace, so the job runs under the oldest workspace; none means no link to sync.
 */
export const armWorkosSync = Effect.gen(function* () {
  if (Option.isNone(yield* WorkosOrganizations)) return;
  const sql = yield* SqlClient.SqlClient;
  const [anchor] = yield* sql<{ id: WorkspaceId }>`SELECT id FROM workspaces ORDER BY created_at, id LIMIT 1`;
  if (anchor !== undefined) yield* enqueueJob({ workspace_id: anchor.id, kind: 'workos.sync', work_key: SYNC_KEY, payload: {}, requested_by: null });
});

/** Applies one event; each is idempotent, so a replay after a lost cursor write is harmless. */
const applyEvent = (issuer: string, event: WorkosEvent) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (event.event === 'organization.deleted') {
      // Detaches the link only; the workspace, its members and recordings stay (docs/DECISIONS.md).
      yield* sql`DELETE FROM workspace_orgs WHERE issuer = ${issuer} AND org_id = ${event.data.id}`;
      return;
    }
    const subject = event.event === 'user.deleted' ? event.data.id : event.data.user_id;
    const principal = yield* identityPrincipal({ issuer, subject });
    if (Option.isNone(principal)) return; // Not signed in yet: the first sign-in creates the member.
    if (event.event === 'user.deleted') {
      for (const held of yield* linkedMemberships(issuer, principal.value)) yield* setMembership(held.workspace_id, principal.value, null);
      return;
    }
    const workspace = yield* workspaceForOrg({ issuer, org_id: event.data.organization_id });
    if (Option.isNone(workspace)) return;
    yield* setMembership(workspace.value, principal.value, event.event === 'organization_membership.deleted' ? null : roleOf(event.data));
  });

/**
 * `workos.sync`: re-arms itself first (so a failed run still schedules the next), then applies new
 * events in order, saving the cursor in the same transaction as each event's effect.
 */
export const syncWorkosEvents: JobHandler<SqlClient.SqlClient | WorkosOrganizations> = job =>
  Effect.gen(function* () {
    const settings = yield* WorkosOrganizations;
    if (Option.isNone(settings)) return { status: 'succeeded', result: { skipped: 'WorkOS is not configured' } } as const;
    const { client, issuer } = settings.value;
    const { intervalMs, pagesPerRun } = engineeringDefaults.workosSync;
    const sql = yield* SqlClient.SqlClient;
    yield* enqueueJob({ workspace_id: job.workspace_id, kind: 'workos.sync', work_key: SYNC_KEY, payload: {}, requested_by: null, delay_ms: intervalMs });
    const [saved] = yield* sql<{ cursor: string }>`SELECT \`cursor\` FROM sync_cursors WHERE name = ${SYNC_CURSOR}`;
    let cursor = saved?.cursor ?? null;
    let applied = 0;
    for (let page = 0; page < pagesPerRun; page++) {
      const events = yield* client.listEvents(cursor);
      for (const event of events) {
        yield* sql.withTransaction(
          Effect.zipRight(
            applyEvent(issuer, event),
            sql`INSERT INTO sync_cursors (name, \`cursor\`, updated_at) VALUES (${SYNC_CURSOR}, ${event.id}, UTC_TIMESTAMP(6)) AS new
              ON DUPLICATE KEY UPDATE \`cursor\` = new.\`cursor\`, updated_at = new.updated_at`,
          ),
        );
        cursor = event.id;
        applied++;
      }
      if (events.length < PAGE_LIMIT) break;
    }
    return { status: 'succeeded', result: { applied, cursor } } as const;
  }).pipe(
    Effect.catchTags({
      WorkosFailure: error => Effect.fail(new JobFailure({ message: error.message, retryable: true })),
      SqlError: Effect.die,
    }),
  );
