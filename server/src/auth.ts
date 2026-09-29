/**
 * Request-authorization seam (plan section 11). Every adapter (REST, MCP, WebSocket, worker)
 * resolves one `AccessScope` and hands it to domain functions, which never read credentials.
 * The kernel slice supplies the real `Authenticator` (browser sessions, agent tokens, device
 * credentials) and membership/meeting checks; no issuer is chosen here (docs/DECISIONS.md).
 */
import { HttpApiBuilder, HttpServerRequest } from '@effect/platform';
import { type AccessScope, Authenticated, CurrentAccess, Forbidden, SanctumApi, Unauthenticated } from '@sanctum/contracts';
import { Context, Effect, Layer } from 'effect';

export class Authenticator extends Context.Tag('sanctum/Authenticator')<
 Authenticator,
 {
  /** Resolves credentials on the request to an access scope; never trusts client-supplied scopes. */
  readonly authenticate: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<AccessScope, Unauthenticated | Forbidden>;
 }
>() { }

/** Refuses every request: no identity issuer, agent credential store or device enrollment is configured. */
export const UnconfiguredAuthenticator = Layer.succeed(Authenticator, {
 authenticate: () => Effect.fail(new Unauthenticated({ message: 'No authentication method is configured' })),
});

export const AuthenticatedLive = Layer.effect(
 Authenticated,
 Effect.map(Authenticator, authenticator => Effect.flatMap(HttpServerRequest.HttpServerRequest, authenticator.authenticate)),
);

export const SessionLive = HttpApiBuilder.group(SanctumApi, 'session', handlers => handlers.handle('getSession', () => CurrentAccess));

// stand-in: replaced by the kernel slice at integration (requireScope, authorizeMeeting, listVisibleMeetingIds)
import { SqlClient, type SqlError } from '@effect/sql';
import { type AccessScopeName, MeetingId, NotFound } from '@sanctum/contracts';

export const requireScope = (access: AccessScope, scope: AccessScopeName): Effect.Effect<void, Forbidden> =>
 access.scopes.includes(scope) ? Effect.void : Effect.fail(new Forbidden({ message: `Missing scope ${scope}`, required_scope: scope }));

const grants = { read: ['read', 'write', 'owner'], write: ['write', 'owner'] } as const;

/** Workspace-visible meetings plus explicit `meeting_access` grants, narrowed by an allowlist credential. */
const visibleMeetings = (access: AccessScope, need: 'read' | 'write', only: string | null) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ id: string }>`SELECT m.id FROM meetings m WHERE m.workspace_id = ${access.workspace_id}
      AND (${only} IS NULL OR m.id = ${only})
      AND (m.visibility = 'workspace' OR EXISTS (SELECT 1 FROM meeting_access a WHERE a.workspace_id = m.workspace_id
        AND a.meeting_id = m.id AND a.principal_id = ${access.principal.id} AND a.access IN ${sql.in(grants[need])}))`;
  const ids = rows.map(row => MeetingId.make(row.id));
  const meetings = access.meetings;
  return meetings.kind === 'allowlist' ? ids.filter(id => meetings.meeting_ids.includes(id)) : ids;
 });

export const authorizeMeeting = (access: AccessScope, meeting_id: string, need: 'read' | 'write'): Effect.Effect<void, NotFound | SqlError.SqlError, SqlClient.SqlClient> =>
 Effect.flatMap(visibleMeetings(access, need, meeting_id), ids => (ids.length === 1 ? Effect.void : Effect.fail(new NotFound({ message: 'Meeting not found' }))));

export const listVisibleMeetingIds = (access: AccessScope): Effect.Effect<ReadonlyArray<MeetingId>, SqlError.SqlError, SqlClient.SqlClient> =>
 visibleMeetings(access, 'read', null);
