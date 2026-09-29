// stand-in: replaced by the kernel slice at integration
/** Cache keys for tenant data: never global, always bound to the resolved access. */
import type { AccessScope } from '@sanctum/contracts';

/** Key including workspace, principal, access fingerprint and permission revision, plus caller parts (source revisions). */
export const scopedCacheKey = (access: AccessScope, ...parts: ReadonlyArray<string | number>): string =>
  JSON.stringify([access.workspace_id, access.principal.id, access.role, [...access.scopes].sort(), access.meetings, access.permission_revision, ...parts]);
