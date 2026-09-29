/**
 * Request-authorization seam (plan section 11). Every adapter (REST, MCP, WebSocket, worker)
 * resolves one `AccessScope` and hands it to domain functions, which never read credentials.
 * The kernel slice supplies the real `Authenticator` (browser sessions, agent tokens, device
 * credentials) and membership/meeting checks; no issuer is chosen here (docs/DECISIONS.md).
 */
import { HttpApiBuilder, HttpServerRequest } from '@effect/platform';
import { SqlClient } from '@effect/sql';
import {
  type AccessScope,
  type AccessScopeName,
  Authenticated,
  CurrentAccess,
  Forbidden,
  type MeetingId,
  NotFound,
  type PrincipalId,
  SanctumApi,
  Unauthenticated,
  type WorkspaceId,
  type WorkspaceRole,
} from '@sanctum/contracts';
import { Context, Effect, Layer } from 'effect';

export class Authenticator extends Context.Tag('sanctum/Authenticator')<
  Authenticator,
  {
    /** Resolves credentials on the request to an access scope; never trusts client-supplied scopes. */
    readonly authenticate: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<AccessScope, Unauthenticated | Forbidden>;
  }
>() {}

/** Refuses every request: no identity issuer, agent credential store or device enrollment is configured. */
export const UnconfiguredAuthenticator = Layer.succeed(Authenticator, {
  authenticate: () => Effect.fail(new Unauthenticated({ message: 'No authentication method is configured' })),
});

export const AuthenticatedLive = Layer.effect(
  Authenticated,
  Effect.map(Authenticator, authenticator => Effect.flatMap(HttpServerRequest.HttpServerRequest, authenticator.authenticate)),
);

export const SessionLive = HttpApiBuilder.group(SanctumApi, 'session', handlers => handlers.handle('getSession', () => CurrentAccess));

// stand-in: replaced by the kernel slice at integration (resolveAccess, requireScope, authorizeMeeting)
const ROLE_SCOPES: Record<WorkspaceRole, ReadonlyArray<AccessScopeName>> = {
  owner: ['context:read', 'context:write', 'recordings:read', 'actions:request', 'actions:execute', 'workspace:admin'],
  admin: ['context:read', 'context:write', 'recordings:read', 'actions:request', 'actions:execute', 'workspace:admin'],
  member: ['context:read', 'context:write', 'recordings:read', 'actions:request'],
  agent: ['context:read', 'context:write', 'actions:request'],
  device: ['capture:ingest'],
};

/** Re-resolves a principal's current membership for workers and sockets; revoked members are refused. */
export const resolveAccess = (input: { readonly workspace_id: WorkspaceId; readonly principal_id: PrincipalId }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ role: WorkspaceRole; kind: AccessScope['principal']['kind']; display_name: string; permission_revision: string }>`
      SELECT m.role, p.kind, p.display_name, w.permission_revision FROM workspace_members m
      JOIN principals p ON p.id = m.principal_id JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.workspace_id = ${input.workspace_id} AND m.principal_id = ${input.principal_id} AND m.revoked_at IS NULL AND p.disabled_at IS NULL`.pipe(Effect.orDie);
    if (!row) return yield* new Forbidden({ message: 'Principal is not an active workspace member' });
    return {
      workspace_id: input.workspace_id,
      principal: { id: input.principal_id, kind: row.kind, display_name: row.display_name },
      role: row.role,
      scopes: ROLE_SCOPES[row.role],
      meetings: { kind: 'accessible' },
      permission_revision: Number(row.permission_revision),
    } satisfies AccessScope;
  });

export const requireScope = (access: AccessScope, scope: AccessScopeName) =>
  access.scopes.includes(scope) ? Effect.void : Effect.fail(new Forbidden({ message: `Missing scope ${scope}`, required_scope: scope }));

/** Missing and unauthorized meetings look the same: NotFound. */
export const authorizeMeeting = (access: AccessScope, meeting_id: MeetingId, need: 'read' | 'write') =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const allowlisted = access.meetings.kind === 'accessible' || access.meetings.meeting_ids.includes(meeting_id);
    const admin = access.role === 'owner' || access.role === 'admin';
    const levels = need === 'read' ? ['read', 'write', 'owner'] : ['write', 'owner'];
    const rows = yield* sql`
      SELECT 1 FROM meetings m LEFT JOIN meeting_access a
        ON a.workspace_id = m.workspace_id AND a.meeting_id = m.id AND a.principal_id = ${access.principal.id}
      WHERE m.workspace_id = ${access.workspace_id} AND m.id = ${meeting_id}
        AND (${admin} OR a.access IN ${sql.in(levels)} OR (m.visibility = 'workspace' AND ${need === 'read'}))`.pipe(Effect.orDie);
    if (!allowlisted || rows.length === 0) return yield* new NotFound({ message: 'Meeting not found' });
  });
