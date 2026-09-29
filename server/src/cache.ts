/**
 * Cache keys for access-derived data (plan section 11). A key names the workspace, principal,
 * permission revision, scopes and meeting access it was computed under, plus the caller's parts
 * (source revisions, cursors). A permission change bumps the revision, so stale entries are never
 * addressed again; JSON encoding keeps parts containing separators from colliding.
 */
import type { AccessScope } from '@sanctum/contracts';

export const scopedCacheKey = (access: AccessScope, ...parts: ReadonlyArray<string | number>): string =>
  JSON.stringify([access.workspace_id, access.principal.id, access.permission_revision, [...access.scopes].sort(), access.meetings, parts]);
