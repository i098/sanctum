/**
 * Agent principals and scoped bearer credentials (plan section 11). Creating an agent needs
 * `workspace:admin` and grants only scopes and meetings the creator holds; revocation bumps the
 * permission revision so cached access derived from the credential is never reused.
 */
import { HttpApiBuilder } from '@effect/platform';
import { SqlClient, SqlSchema, type Statement } from '@effect/sql';
import {
  type AccessScope,
  AccessScopeName,
  AgentCredentialId,
  type AgentWithCredential,
  type CreateAgent,
  CurrentAccess,
  Forbidden,
  MeetingId,
  NotFound,
  PrincipalId,
} from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Effect, Schema } from 'effect';
import { authorizeMeeting, hashToken, newToken, requireScope } from './auth.ts';
import { DbJson, DbUtc } from './db.ts';
import { addMember, bumpPermissionRevision, write } from './store.ts';

const CredentialRow = Schema.Struct({
  id: AgentCredentialId,
  agent_id: PrincipalId,
  display_name: Schema.String,
  scopes: DbJson(Schema.Array(AccessScopeName)),
  meeting_allowlist: Schema.NullOr(DbJson(Schema.Array(MeetingId))),
  expires_at: Schema.NullOr(DbUtc),
  revoked_at: Schema.NullOr(DbUtc),
  last_used_at: Schema.NullOr(DbUtc),
  created_at: DbUtc,
});

const toAgent = ({ agent_id, display_name, meeting_allowlist, ...credential }: typeof CredentialRow.Type): AgentWithCredential => ({
  agent: { id: agent_id, kind: 'agent', display_name },
  credential: {
    ...credential,
    meetings: meeting_allowlist === null ? { kind: 'accessible' } : { kind: 'allowlist', meeting_ids: meeting_allowlist },
  },
});

const isAdmin = (access: AccessScope) => access.scopes.includes('workspace:admin');

/** Credentials visible to the caller: all for admins, otherwise only those the caller owns. */
const credentials = (access: AccessScope, where: (sql: SqlClient.SqlClient) => Statement.Fragment, limit: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const owned = isAdmin(access) ? sql`TRUE` : sql`c.owner_principal_id = ${access.principal.id}`;
    return yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: CredentialRow,
      execute: () => sql`SELECT c.id, c.principal_id AS agent_id, p.display_name, c.scopes, c.meeting_allowlist,
          c.expires_at, c.revoked_at, c.last_used_at, c.created_at
        FROM agent_credentials c JOIN principals p ON p.id = c.principal_id
        WHERE c.workspace_id = ${access.workspace_id} AND ${owned} AND ${where(sql)}
        ORDER BY c.id LIMIT ${limit}`,
    })(undefined).pipe(Effect.orDie);
  });

export const createAgent = (access: AccessScope, input: CreateAgent) =>
  Effect.gen(function* () {
    yield* requireScope(access, 'workspace:admin');
    const excess = input.scopes.filter(scope => !access.scopes.includes(scope));
    if (excess.length > 0) return yield* new Forbidden({ message: `Cannot grant scopes the creator lacks: ${excess.join(', ')}` });
    if (input.meetings.kind === 'allowlist') yield* Effect.forEach(input.meetings.meeting_ids, id => authorizeMeeting(access, id, 'read'));
    const sql = yield* SqlClient.SqlClient;
    const agent_id = PrincipalId.make(crypto.randomUUID());
    const id = AgentCredentialId.make(crypto.randomUUID());
    const token = newToken();
    const allowlist = input.meetings.kind === 'allowlist' ? JSON.stringify(input.meetings.meeting_ids) : null;
    const expires = input.expires_at === null ? null : Schema.encodeSync(DbUtc)(input.expires_at);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO principals (id, kind, display_name, created_at) VALUES (${agent_id}, 'agent', ${input.display_name}, UTC_TIMESTAMP(6))`;
        yield* addMember({ workspace_id: access.workspace_id, principal_id: agent_id, role: 'agent' });
        yield* sql`INSERT INTO agent_credentials (id, workspace_id, principal_id, owner_principal_id, token_hash, scopes, meeting_allowlist, expires_at, created_at)
          VALUES (${id}, ${access.workspace_id}, ${agent_id}, ${access.principal.id}, ${hashToken(token)}, ${JSON.stringify([...new Set(input.scopes)])},
            ${allowlist}, ${expires}, UTC_TIMESTAMP(6))`;
      }),
    ).pipe(Effect.orDie);
    const [created] = yield* credentials(access, sql => sql`c.id = ${id}`, 1);
    return { ...toAgent(created!), token };
  });

/** Keyset page ordered by credential ID; the cursor is the last ID returned. */
const listAgents = (access: AccessScope, page: { readonly cursor?: string | undefined; readonly limit?: number | undefined }) =>
  Effect.gen(function* () {
    const limit = page.limit ?? 50;
    const rows = yield* credentials(access, sql => (page.cursor === undefined ? sql`TRUE` : sql`c.id > ${page.cursor}`), limit + 1);
    return { items: rows.slice(0, limit).map(toAgent), next_cursor: rows.length > limit ? rows[limit - 1]!.id : null };
  });

/** Idempotent for the credential's owner or an admin; anything else is indistinguishable from missing. */
const revokeCredential = (access: AccessScope, agent_id: PrincipalId, key_id: AgentCredentialId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [credential] = yield* credentials(access, sql => sql`c.id = ${key_id} AND c.principal_id = ${agent_id}`, 1);
    if (!credential) return yield* new NotFound({ message: 'Credential not found' });
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const revoked = yield* write(sql`UPDATE agent_credentials SET revoked_at = UTC_TIMESTAMP(6)
            WHERE workspace_id = ${access.workspace_id} AND id = ${key_id} AND revoked_at IS NULL`);
          if (revoked.affectedRows === 1) yield* bumpPermissionRevision(access.workspace_id);
        }),
      )
      .pipe(Effect.orDie);
  });

export const AgentsLive = HttpApiBuilder.group(SanctumApi, 'agents', handlers =>
  handlers
    .handle('createAgent', ({ payload }) => Effect.flatMap(CurrentAccess, access => createAgent(access, payload)))
    .handle('listAgents', ({ urlParams }) => Effect.flatMap(CurrentAccess, access => listAgents(access, urlParams)))
    .handle('revokeCredential', ({ path }) => Effect.flatMap(CurrentAccess, access => revokeCredential(access, path.agent_id, path.key_id))),
);
