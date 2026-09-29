/** Authenticated principal and the access scope every domain function receives. */
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from '@effect/platform';
import { Context, Schema } from 'effect';
import { MeetingId, PrincipalId, WorkspaceId } from './common.ts';
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
  display_name: Schema.String,
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
