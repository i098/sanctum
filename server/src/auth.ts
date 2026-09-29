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
  MeetingId,
  NotFound,
  SanctumApi,
  Unauthenticated,
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

// stand-in: replaced by the kernel slice at integration
export const requireScope = (access: AccessScope, scope: AccessScopeName) =>
  access.scopes.includes(scope) ? Effect.void : Effect.fail(new Forbidden({ message: `Missing scope ${scope}`, required_scope: scope }));

// stand-in: replaced by the kernel slice at integration
/** Workspace-visible meetings (read), explicit grants, or every meeting for owners/admins; then the credential allowlist. */
const visibleMeetings = (access: AccessScope, need: 'read' | 'write', meetingId: MeetingId | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const admin = access.role === 'owner' || access.role === 'admin';
    const levels = need === 'read' ? ['read', 'write', 'owner'] : ['write', 'owner'];
    const rows = yield* sql<{ id: string }>`SELECT m.id FROM meetings m
      WHERE m.workspace_id = ${access.workspace_id} ${meetingId === null ? sql`` : sql`AND m.id = ${meetingId}`}
        AND (${admin} OR (${need === 'read'} AND m.visibility = 'workspace') OR EXISTS (
          SELECT 1 FROM meeting_access a WHERE a.meeting_id = m.id AND a.principal_id = ${access.principal.id} AND a.access IN ${sql.in(levels)}))`;
    const allowed = access.meetings.kind === 'allowlist' ? access.meetings.meeting_ids : null;
    return rows.map(row => MeetingId.make(row.id)).filter(id => allowed === null || allowed.includes(id));
  });

// stand-in: replaced by the kernel slice at integration
export const authorizeMeeting = (access: AccessScope, meeting_id: MeetingId, need: 'read' | 'write') =>
  visibleMeetings(access, need, meeting_id).pipe(
    Effect.orDie,
    Effect.flatMap(ids => (ids.length === 1 ? Effect.void : Effect.fail(new NotFound({ message: 'Meeting not found' })))),
  );

// stand-in: replaced by the kernel slice at integration
export const listVisibleMeetingIds = (access: AccessScope) => visibleMeetings(access, 'read', null);
