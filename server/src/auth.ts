/**
 * Request-authorization seam (plan section 11). Every adapter (REST, MCP, WebSocket, worker)
 * resolves one `AccessScope` and hands it to domain functions, which never read credentials.
 * The kernel slice supplies the real `Authenticator` (browser sessions, agent tokens, device
 * credentials) and membership/meeting checks; no issuer is chosen here (docs/DECISIONS.md).
 */
import { HttpApiBuilder, HttpServerRequest } from '@effect/platform';
import { SqlClient, SqlSchema } from '@effect/sql';
import {
  type AccessScope,
  AccessScopeName,
  Authenticated,
  CurrentAccess,
  Forbidden,
  PrincipalId,
  PrincipalKind,
  SanctumApi,
  Unauthenticated,
  WorkspaceId,
  WorkspaceRole,
} from '@sanctum/contracts';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { DbSafeInt } from './db.ts';

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
const ROLE_SCOPES: Record<WorkspaceRole, ReadonlyArray<AccessScopeName>> = {
  owner: AccessScopeName.literals.filter(scope => scope !== 'capture:ingest'),
  admin: AccessScopeName.literals.filter(scope => scope !== 'capture:ingest'),
  member: ['context:read', 'context:write', 'recordings:read', 'actions:request'],
  agent: ['context:read', 'context:write', 'recordings:read', 'actions:request'],
  device: ['capture:ingest'],
};

const MemberRow = Schema.Struct({
  kind: PrincipalKind,
  display_name: Schema.String,
  role: WorkspaceRole,
  permission_revision: DbSafeInt,
});

const IdentityRequest = Schema.Struct({ workspace_id: WorkspaceId, principal_id: PrincipalId });

// stand-in: replaced by the kernel slice at integration
/** Active membership of an enabled principal, with the role's scope ceiling. */
export const resolveAccess = (input: typeof IdentityRequest.Type) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findOne({
      Request: IdentityRequest,
      Result: MemberRow,
      execute: ({ workspace_id, principal_id }) => sql`
                SELECT p.kind, p.display_name, m.role, w.permission_revision
                FROM workspace_members m
                JOIN principals p ON p.id = m.principal_id
                JOIN workspaces w ON w.id = m.workspace_id
                WHERE m.workspace_id = ${workspace_id} AND m.principal_id = ${principal_id}
                    AND m.revoked_at IS NULL AND p.disabled_at IS NULL`,
    });
    const row = yield* Effect.orDie(find(input));
    if (Option.isNone(row)) return yield* new Forbidden({ message: 'Not an active workspace member' });
    const { kind, display_name, role, permission_revision } = row.value;
    return {
      workspace_id: input.workspace_id,
      principal: { id: input.principal_id, kind, display_name },
      role,
      scopes: ROLE_SCOPES[role],
      meetings: { kind: 'accessible' },
      permission_revision,
    } satisfies AccessScope;
  });
