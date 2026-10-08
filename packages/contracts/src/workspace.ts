/** Workspace deletion for its owner: soft delete, undo during the grace period, then a durable purge (plan 10.1 option A). */
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from '@effect/platform';
import { Schema } from 'effect';
import { CurrentAccess } from './auth.ts';
import { UtcTimestamp, WorkspaceId } from './common.ts';
import { Forbidden, Unauthenticated } from './errors.ts';

/**
 * An owner's browser session, also while the workspace is deleted but not yet due for purge, so
 * the owner can still see the deletion and undo it. Every other access to a deleted workspace is refused.
 */
export class WorkspaceOwner extends HttpApiMiddleware.Tag<WorkspaceOwner>()('WorkspaceOwner', {
  failure: Schema.Union(Unauthenticated, Forbidden),
  provides: CurrentAccess,
}) {}

export const Workspace = Schema.Struct({
  id: WorkspaceId,
  name: Schema.String,
  /** Set while deletion is pending: members, sessions and agent credentials of the workspace are refused. */
  deleted_at: Schema.NullOr(UtcTimestamp),
  /** Recordings and rows are purged after this time; until then the owner can restore the workspace. */
  purge_after: Schema.NullOr(UtcTimestamp),
});
export type Workspace = typeof Workspace.Type;

/** The owner types the workspace name exactly to confirm. */
export const DeleteWorkspace = Schema.Struct({ confirm_name: Schema.String });

export class WorkspaceApi extends HttpApiGroup.make('workspace')
  .add(HttpApiEndpoint.get('getWorkspace', '/workspace').addSuccess(Workspace))
  .add(HttpApiEndpoint.del('deleteWorkspace', '/workspace').setPayload(DeleteWorkspace).addSuccess(Workspace))
  .add(HttpApiEndpoint.post('restoreWorkspace', '/workspace/restore').addSuccess(Workspace))
  .middleware(WorkspaceOwner)
  .prefix('/api/v1') {}
