/**
 * First owner of a fresh install (`npm run owner -w server -- ...`): the operator copies the
 * issuer and subject from a refused sign-in (`/?signin=not_member&issuer=…&subject=…`). One
 * transaction creates the workspace, the human principal, its identity and the owner membership,
 * so membership never comes from email and no first visitor of a public URL becomes owner.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { NodeRuntime } from '@effect/platform-node';
import { SqlClient } from '@effect/sql';
import { PrincipalId, WorkspaceId } from '@sanctum/contracts';
import { Data, Effect } from 'effect';
import { serverConfig } from './config.ts';
import { dbLayer } from './db.ts';
import { now } from './sql-dialect.ts';
import { bumpPermissionRevision, claimSeat } from './store.ts';

export class OwnerRefused extends Data.TaggedError('OwnerRefused')<{ readonly message: string }> {}

export interface OwnerInput {
  readonly issuer: string;
  readonly subject: string;
  readonly display_name: string;
  /** A new workspace (refused while a live one exists), or the id of an existing live workspace to add an owner to. */
  readonly workspace: { readonly name: string; readonly timezone: string } | { readonly id: WorkspaceId };
}

/** Reads the workspace that gets another owner; a missing or deleted one is refused. */
const existingWorkspace = (workspace_id: WorkspaceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [found] = yield* sql<{ deleted_at: string | null; purge_after: string | null }>`SELECT substr(deleted_at, 1, 19) AS deleted_at,
      substr(purge_after, 1, 19) AS purge_after FROM workspaces WHERE id = ${workspace_id}`;
    if (found === undefined) return yield* new OwnerRefused({ message: `Workspace ${workspace_id} does not exist` });
    if (found.deleted_at !== null) {
      return yield* new OwnerRefused({ message: `Workspace ${workspace_id} was deleted at ${found.deleted_at} UTC and is purged from ${found.purge_after} UTC; it cannot get an owner` });
    }
    return { workspace_id, known: undefined as PrincipalId | undefined };
  });

/** Checks that a fresh install has no live workspace, picks the new id and reports the principal this identity already has, if any. */
const newWorkspace = (input: OwnerInput, { timezone }: { readonly timezone: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.try({ try: () => new Intl.DateTimeFormat('en-US', { timeZone: timezone }), catch: () => new OwnerRefused({ message: `Unknown IANA time zone ${timezone}` }) });
    const [existing] = yield* sql`SELECT id FROM workspaces WHERE deleted_at IS NULL LIMIT 1`;
    if (existing !== undefined) return yield* new OwnerRefused({ message: 'A workspace already exists; pass --workspace-id to add an owner to it' });
    const [identity] = yield* sql<{ principal_id: PrincipalId; usable: number }>`SELECT i.principal_id, (p.kind = 'human' AND p.disabled_at IS NULL) AS usable
      FROM principal_identities i JOIN principals p ON p.id = i.principal_id WHERE i.issuer = ${input.issuer} AND i.subject = ${input.subject}`;
    if (identity !== undefined && Number(identity.usable) !== 1) return yield* new OwnerRefused({ message: 'This identity belongs to a disabled or non-human principal' });
    return { workspace_id: WorkspaceId.make(randomUUID()), known: identity?.principal_id };
  });

/**
 * One transaction, so a failure leaves nothing behind. A transaction cannot read after its first write,
 * so every read comes first, including the seat check `addMember` would make; the membership row
 * is then written here with the same upsert.
 */
export const createOwner = (input: OwnerInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { workspace_id, known } = yield* 'id' in input.workspace ? existingWorkspace(input.workspace.id) : newWorkspace(input, input.workspace);
        const principal_id = known ?? PrincipalId.make(randomUUID());
        yield* claimSeat(workspace_id, principal_id);
        if ('name' in input.workspace) {
          yield* sql`INSERT INTO workspaces (id, name, timezone, created_at) VALUES (${workspace_id}, ${input.workspace.name}, ${input.workspace.timezone}, ${now})`;
        }
        if (known === undefined) {
          yield* sql`INSERT INTO principals (id, kind, display_name, created_at) VALUES (${principal_id}, 'human', ${input.display_name}, ${now})`;
          yield* sql`INSERT INTO principal_identities (issuer, subject, principal_id, verified_at) VALUES (${input.issuer}, ${input.subject}, ${principal_id}, ${now})`;
        }
        yield* sql`INSERT INTO workspace_members (workspace_id, principal_id, role, org_issuer, created_at) VALUES (${workspace_id}, ${principal_id}, 'owner', NULL, ${now})
          ON CONFLICT (workspace_id, principal_id) DO UPDATE SET role = excluded.role, revoked_at = NULL, org_issuer = excluded.org_issuer`;
        // A workspace created just now has no cache keyed by its revision, and its row is not committed yet.
        if ('id' in input.workspace) yield* bumpPermissionRevision(workspace_id);
        return { workspace_id, principal_id };
      }),
    );
  });

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      issuer: { type: 'string' },
      subject: { type: 'string' },
      'display-name': { type: 'string' },
      workspace: { type: 'string' },
      timezone: { type: 'string' },
      'workspace-id': { type: 'string' },
    },
  });
  const { issuer, subject, 'display-name': display_name, workspace, timezone, 'workspace-id': id } = values;
  if (!issuer || !subject || !display_name || !(id || (workspace && timezone))) {
    console.error('Usage: npm run owner -w server -- --issuer <iss> --subject <sub> --display-name "<name>" (--workspace "<name>" --timezone <IANA> | --workspace-id <id>)');
    process.exit(2);
  }
  Effect.gen(function* () {
    const config = yield* serverConfig;
    const created = yield* createOwner({ issuer, subject, display_name, workspace: id ? { id: WorkspaceId.make(id) } : { name: workspace!, timezone: timezone! } }).pipe(
      Effect.provide(dbLayer(config.db)),
    );
    yield* Effect.logInfo('Owner created', created);
  }).pipe(NodeRuntime.runMain);
}
