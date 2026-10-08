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
import { addMember } from './store.ts';

export class OwnerRefused extends Data.TaggedError('OwnerRefused')<{ readonly message: string }> {}

export interface OwnerInput {
  readonly issuer: string;
  readonly subject: string;
  readonly display_name: string;
  /** A new workspace (refused while any exists), or the id of an existing one to add an owner to. */
  readonly workspace: { readonly name: string; readonly timezone: string } | { readonly id: WorkspaceId };
}

export const createOwner = (input: OwnerInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        let workspace_id: WorkspaceId;
        if ('id' in input.workspace) {
          workspace_id = input.workspace.id;
          const [found] = yield* sql`SELECT id FROM workspaces WHERE id = ${workspace_id} FOR UPDATE`;
          if (found === undefined) return yield* new OwnerRefused({ message: `Workspace ${workspace_id} does not exist` });
        } else {
          const { name, timezone } = input.workspace;
          yield* Effect.try({ try: () => new Intl.DateTimeFormat('en-US', { timeZone: timezone }), catch: () => new OwnerRefused({ message: `Unknown IANA time zone ${timezone}` }) });
          const [existing] = yield* sql`SELECT id FROM workspaces LIMIT 1 FOR UPDATE`;
          if (existing !== undefined) return yield* new OwnerRefused({ message: 'A workspace already exists; pass --workspace-id to add an owner to it' });
          workspace_id = WorkspaceId.make(randomUUID());
          yield* sql`INSERT INTO workspaces (id, name, timezone, created_at) VALUES (${workspace_id}, ${name}, ${timezone}, UTC_TIMESTAMP(6))`;
        }
        const principal_id = PrincipalId.make(randomUUID());
        yield* sql`INSERT INTO principals (id, kind, display_name, created_at) VALUES (${principal_id}, 'human', ${input.display_name}, UTC_TIMESTAMP(6))`;
        yield* sql`INSERT INTO principal_identities (issuer, subject, principal_id, verified_at) VALUES (${input.issuer}, ${input.subject}, ${principal_id}, UTC_TIMESTAMP(6))`;
        yield* addMember({ workspace_id, principal_id, role: 'owner' });
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
      Effect.provide(dbLayer(config.mysql)),
    );
    yield* Effect.logInfo('Owner created', created);
  }).pipe(NodeRuntime.runMain);
}
