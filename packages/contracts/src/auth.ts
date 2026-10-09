/** Authenticated principal and the access scope every domain function receives. */
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema } from '@effect/platform';
import { Context, Schema } from 'effect';
import { AgentCredentialId, Cursor, MeetingId, PrincipalId, UtcTimestamp, WorkspaceId } from './common.ts';
import { Forbidden, Unauthenticated } from './errors.ts';

export const PrincipalKind = Schema.Literal('human', 'agent', 'device');
export type PrincipalKind = typeof PrincipalKind.Type;

export const WorkspaceRole = Schema.Literal('owner', 'admin', 'member', 'agent', 'device');
export type WorkspaceRole = typeof WorkspaceRole.Type;

/** Plan section 11 minimum scopes plus the narrower device ingest scope. */
export const AccessScopeName = Schema.Literal(
  'context:read',
  'context:write',
  'recordings:read',
  'actions:request',
  'actions:execute',
  'workspace:admin',
  'capture:ingest',
);
export type AccessScopeName = typeof AccessScopeName.Type;

export const Principal = Schema.Struct({
  id: PrincipalId,
  kind: PrincipalKind,
  /** Null for a human whose issuer reported no name; the caller's own `email` then names them. */
  display_name: Schema.NullOr(Schema.String),
  /** The sign-in email the issuer last reported; only the caller's own access (`getSession`) carries it. */
  email: Schema.optional(Schema.String),
});
export type Principal = typeof Principal.Type;

/** Meetings reachable through this access: all the principal may see, or an explicit allowlist. */
export const MeetingAccess = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('accessible') }),
  Schema.Struct({ kind: Schema.Literal('allowlist'), meeting_ids: Schema.Array(MeetingId) }),
);
export type MeetingAccess = typeof MeetingAccess.Type;

/**
 * Resolved authorization for one request or job: one workspace, explicit membership role,
 * granted scopes and the permission revision it was resolved at (cache keys include it).
 */
export const AccessScope = Schema.Struct({
  workspace_id: WorkspaceId,
  principal: Principal,
  role: WorkspaceRole,
  scopes: Schema.Array(AccessScopeName),
  meetings: MeetingAccess,
  permission_revision: Schema.Number.pipe(Schema.int(), Schema.positive()),
});
export type AccessScope = typeof AccessScope.Type;

/** The authenticated caller of the current request or job; provided by `Authenticated`. */
export class CurrentAccess extends Context.Tag('sanctum/CurrentAccess')<CurrentAccess, AccessScope>() {}

/** Apply with `.middleware(Authenticated)` to every non-public API group; the server implements it. */
export class Authenticated extends HttpApiMiddleware.Tag<Authenticated>()('Authenticated', {
  failure: Schema.Union(Unauthenticated, Forbidden),
  provides: CurrentAccess,
}) {}

/** `GET /api/v1/session`: the caller's resolved workspace, principal, role and scopes. */
export class SessionApi extends HttpApiGroup.make('session')
  .add(HttpApiEndpoint.get('getSession', '/session').addSuccess(AccessScope))
  .middleware(Authenticated)
  .prefix('/api/v1') {}

// Agent principals and their scoped, revocable bearer credentials (kernel slice, plan sections 11 and 12).
// Kept beside SessionApi: a separate module importing this one would deepen every import chain.
/** Scopes must be a subset of the creator's; allowlisted meetings must be readable by the creator. */
export const CreateAgent = Schema.Struct({
  display_name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  scopes: Schema.Array(AccessScopeName),
  meetings: MeetingAccess,
  expires_at: Schema.NullOr(UtcTimestamp),
});
export type CreateAgent = typeof CreateAgent.Type;

export const AgentCredential = Schema.Struct({
  id: AgentCredentialId,
  scopes: Schema.Array(AccessScopeName),
  meetings: MeetingAccess,
  expires_at: Schema.NullOr(UtcTimestamp),
  revoked_at: Schema.NullOr(UtcTimestamp),
  last_used_at: Schema.NullOr(UtcTimestamp),
  created_at: UtcTimestamp,
});

export const AgentWithCredential = Schema.Struct({ agent: Principal, credential: AgentCredential });
export type AgentWithCredential = typeof AgentWithCredential.Type;

/** `token` is the only plain copy of the bearer credential; the server stores its hash. */
export const CreatedAgent = Schema.Struct({ ...AgentWithCredential.fields, token: Schema.String });

export const AgentPage = Schema.Struct({ items: Schema.Array(AgentWithCredential), next_cursor: Schema.NullOr(Cursor) });

export const AgentPageParams = Schema.Struct({
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 200))),
});

const agentId = HttpApiSchema.param('agent_id', PrincipalId);
const keyId = HttpApiSchema.param('key_id', AgentCredentialId);

/** Admins see every credential of the workspace; other callers only the ones they own. */
export class AgentsApi extends HttpApiGroup.make('agents')
  .add(HttpApiEndpoint.post('createAgent', '/agents').setPayload(CreateAgent).addSuccess(CreatedAgent, { status: 201 }))
  .add(HttpApiEndpoint.get('listAgents', '/agents').setUrlParams(AgentPageParams).addSuccess(AgentPage))
  .add(HttpApiEndpoint.del('revokeCredential')`/agents/${agentId}/credentials/${keyId}`)
  .middleware(Authenticated)
  .prefix('/api/v1') {}
