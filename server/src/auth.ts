/**
 * Request-authorization seam (plan section 11). Every adapter (REST, MCP, WebSocket, worker)
 * resolves one `AccessScope` and hands it to domain functions, which never read credentials.
 * The kernel authenticator accepts browser sessions (cookie + CSRF header on mutations) and
 * hashed bearer credentials; no login issuer is chosen here (docs/DECISIONS.md), so sessions
 * are opened only for an already verified identity or enrolled device.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Cookies, HttpApiBuilder, HttpServerRequest } from '@effect/platform';
import { SqlClient, SqlSchema, type SqlError } from '@effect/sql';
import {
  type AccessScope,
  AccessScopeName,
  Authenticated,
  CurrentAccess,
  Forbidden,
  MeetingId,
  NotFound,
  PrincipalId,
  PrincipalKind,
  SanctumApi,
  Unauthenticated,
  WorkspaceId,
  WorkspaceRole,
} from '@sanctum/contracts';
import { Config, Context, Effect, Layer, Option, Schema } from 'effect';
import { DbJson, DbSafeInt } from './db.ts';

export class Authenticator extends Context.Tag('sanctum/Authenticator')<
  Authenticator,
  {
    /** Resolves credentials on the request to an access scope; never trusts client-supplied scopes. */
    readonly authenticate: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<AccessScope, Unauthenticated | Forbidden>;
  }
>() {}

export const AuthenticatedLive = Layer.effect(
  Authenticated,
  Effect.map(Authenticator, authenticator => Effect.flatMap(HttpServerRequest.HttpServerRequest, authenticator.authenticate)),
);

export const SessionLive = HttpApiBuilder.group(SanctumApi, 'session', handlers => handlers.handle('getSession', () => CurrentAccess));

const SESSION_COOKIE = 'sanctum_session';
const CSRF_HEADER = 'x-csrf-token';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const ALL_SCOPES = AccessScopeName.literals;
/** Human and device scopes follow the membership role; agent scopes come only from credentials. */
const ROLE_SCOPES: Record<WorkspaceRole, ReadonlyArray<AccessScopeName>> = {
  owner: ALL_SCOPES,
  admin: ALL_SCOPES,
  member: ALL_SCOPES.filter(scope => scope !== 'workspace:admin'),
  agent: [],
  device: ['capture:ingest'],
};

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest();

const Scopes = DbJson(Schema.Array(AccessScopeName));
const Allowlist = Schema.NullOr(DbJson(Schema.Array(MeetingId)));

const MemberRow = Schema.Struct({
  workspace_id: WorkspaceId,
  principal_id: PrincipalId,
  kind: PrincipalKind,
  display_name: Schema.String,
  role: WorkspaceRole,
  permission_revision: DbSafeInt,
});
type MemberRow = typeof MemberRow.Type;

const toAccess = (member: MemberRow, scopes: ReadonlyArray<AccessScopeName>, allowlist: ReadonlyArray<MeetingId> | null): AccessScope => ({
  workspace_id: member.workspace_id,
  principal: { id: member.principal_id, kind: member.kind, display_name: member.display_name },
  role: member.role,
  scopes,
  meetings: allowlist === null ? { kind: 'accessible' } : { kind: 'allowlist', meeting_ids: allowlist },
  permission_revision: member.permission_revision,
});

/** Active membership of an enabled principal, joined as `m`, `p` and `w`. */
const activeMember = (sql: SqlClient.SqlClient) => sql`
  JOIN workspace_members m ON m.workspace_id = x.workspace_id AND m.principal_id = x.principal_id AND m.revoked_at IS NULL
  JOIN principals p ON p.id = m.principal_id AND p.disabled_at IS NULL
  JOIN workspaces w ON w.id = m.workspace_id`;
const memberColumns = (sql: SqlClient.SqlClient) => sql`m.workspace_id, m.principal_id, p.kind, p.display_name, m.role, w.permission_revision`;

/** Row decoding failures are defects (schema drift), not caller errors. */
const findOne = <A, I>(Result: Schema.Schema<A, I>, statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
  SqlSchema.findOne({ Request: Schema.Void, Result, execute: () => statement })(undefined).pipe(Effect.catchTag('ParseError', Effect.die));

const sessionAccess = (token: string, csrfToken: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const Row = Schema.Struct({ ...MemberRow.fields, csrf_hash: Schema.Uint8ArrayFromSelf });
    const idHash = hashToken(token);
    const row = yield* findOne(Row, sql`SELECT ${memberColumns(sql)}, x.csrf_hash FROM browser_sessions x ${activeMember(sql)}
      WHERE x.id_hash = ${idHash} AND x.revoked_at IS NULL AND x.expires_at > UTC_TIMESTAMP(6) AND p.kind IN ('human', 'device')`);
    if (Option.isNone(row)) return yield* new Unauthenticated({ message: 'Session is not valid' });
    if (csrfToken !== null && !timingSafeEqual(hashToken(csrfToken), row.value.csrf_hash)) {
      return yield* new Forbidden({ message: 'CSRF token is missing or invalid' });
    }
    yield* sql`UPDATE browser_sessions SET last_seen_at = UTC_TIMESTAMP(6) WHERE id_hash = ${idHash}`;
    return toAccess(row.value, ROLE_SCOPES[row.value.role], null);
  });

const credentialAccess = (token: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const Row = Schema.Struct({ ...MemberRow.fields, id: Schema.String, scopes: Scopes, meeting_allowlist: Allowlist });
    const row = yield* findOne(Row, sql`SELECT ${memberColumns(sql)}, x.id, x.scopes, x.meeting_allowlist FROM agent_credentials x ${activeMember(sql)}
      WHERE x.token_hash = ${hashToken(token)} AND x.revoked_at IS NULL AND (x.expires_at IS NULL OR x.expires_at > UTC_TIMESTAMP(6))`);
    if (Option.isNone(row)) return yield* new Unauthenticated({ message: 'Credential is not valid' });
    yield* sql`UPDATE agent_credentials SET last_used_at = UTC_TIMESTAMP(6) WHERE id = ${row.value.id}`;
    return toAccess(row.value, row.value.scopes, row.value.meeting_allowlist);
  });

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Bearer credentials first, then the session cookie; cookie mutations also need the CSRF header. */
const authenticate = (request: HttpServerRequest.HttpServerRequest) => {
  const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
  if (bearer) return credentialAccess(bearer);
  const session = request.cookies[SESSION_COOKIE];
  if (!session) return Effect.fail(new Unauthenticated({ message: 'No credentials' }));
  return sessionAccess(session, SAFE_METHODS.has(request.method) ? null : (request.headers[CSRF_HEADER] ?? ''));
};

/** Database failures during authentication are defects (HTTP 500), never a silent grant. */
export const KernelAuthenticatorLive = Layer.effect(
  Authenticator,
  Effect.map(SqlClient.SqlClient, sql => ({
    authenticate: (request: HttpServerRequest.HttpServerRequest) =>
      authenticate(request).pipe(Effect.catchTag('SqlError', Effect.die), Effect.provideService(SqlClient.SqlClient, sql)),
  })),
);

/**
 * WebSocket upgrades carry only the same-origin session cookie (every session role holds
 * `capture:ingest`); the Origin must be listed in `SANCTUM_ALLOWED_ORIGINS` (comma-separated, none by default).
 */
export const authenticateUpgrade = (request: IncomingMessage) =>
  Effect.gen(function* () {
    const allowed: ReadonlyArray<string> = yield* Config.array(Config.string(), 'SANCTUM_ALLOWED_ORIGINS').pipe(Config.withDefault([]), Effect.orDie);
    const origin = request.headers.origin;
    if (!origin || !allowed.includes(origin)) return yield* new Forbidden({ message: 'Origin is not allowed' });
    const session = Cookies.parseHeader(request.headers.cookie ?? '')[SESSION_COOKIE];
    if (!session) return yield* new Unauthenticated({ message: 'No session' });
    return yield* sessionAccess(session, null);
  }).pipe(Effect.catchTag('SqlError', Effect.die));

/**
 * Access of a member acting outside a request (workers, open sockets). Agents keep the union of
 * their active credentials, so revoking the last one stops their background work.
 */
type MemberKey = { readonly workspace_id: WorkspaceId; readonly principal_id: PrincipalId };

const findMember = (input: MemberKey) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    findOne(MemberRow, sql`SELECT ${memberColumns(sql)}
      FROM (SELECT ${input.workspace_id} AS workspace_id, ${input.principal_id} AS principal_id) x ${activeMember(sql)}`),
  );

export const resolveAccess = (input: MemberKey) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const member = yield* findMember(input);
    if (Option.isNone(member)) return yield* new Forbidden({ message: 'Not an active member of this workspace' });
    if (member.value.role !== 'agent') return toAccess(member.value, ROLE_SCOPES[member.value.role], null);
    const credentials = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ scopes: Scopes, meeting_allowlist: Allowlist }),
      execute: () => sql`SELECT scopes, meeting_allowlist FROM agent_credentials
        WHERE workspace_id = ${input.workspace_id} AND principal_id = ${input.principal_id}
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(6))`,
    })(undefined).pipe(Effect.catchTag('ParseError', Effect.die));
    if (credentials.length === 0) return yield* new Forbidden({ message: 'Agent has no active credential' });
    const scopes = [...new Set(credentials.flatMap(credential => credential.scopes))];
    const allowlists = credentials.map(credential => credential.meeting_allowlist);
    return toAccess(member.value, scopes, allowlists.includes(null) ? null : [...new Set(allowlists.flatMap(list => list ?? []))]);
  }).pipe(Effect.catchTag('SqlError', Effect.die));

export const requireScope = (access: AccessScope, scope: AccessScopeName) =>
  access.scopes.includes(scope) ? Effect.void : Effect.fail(new Forbidden({ message: `Requires ${scope}`, required_scope: scope }));

/**
 * Opens a browser session for an active human or device member, e.g. after the (unselected)
 * login issuer verified an identity or after device enrollment. Returns the only plain copies of
 * the cookie and CSRF tokens.
 */
export const openSession = (input: MemberKey) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const member = yield* findMember(input);
    if (Option.isNone(member) || member.value.kind === 'agent') return yield* new Forbidden({ message: 'Not an active human or device member' });
    const token = newToken();
    const csrf_token = newToken();
    const expires_at = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    yield* sql`INSERT INTO browser_sessions (id_hash, workspace_id, principal_id, csrf_hash, created_at, expires_at, last_seen_at)
      VALUES (${hashToken(token)}, ${input.workspace_id}, ${input.principal_id}, ${hashToken(csrf_token)}, UTC_TIMESTAMP(6),
        ${expires_at.slice(0, -1).replace('T', ' ')}, UTC_TIMESTAMP(6))`;
    return { token, csrf_token, expires_at };
  });

/** Principal of a verified issuer/subject pair; exact match only, never by email or domain. */
export const identityPrincipal = (identity: { readonly issuer: string; readonly subject: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = yield* findOne(
      Schema.Struct({ principal_id: PrincipalId }),
      sql`SELECT principal_id FROM principal_identities WHERE issuer = ${identity.issuer} AND subject = ${identity.subject}`,
    );
    return Option.map(row, value => value.principal_id);
  });

type MeetingAccessRow = { visibility: 'restricted' | 'workspace'; access: 'read' | 'write' | 'owner' | null };

/** Unreadable, unwritable and foreign meetings all fail as the same NotFound. */
export const authorizeMeeting = (access: AccessScope, meeting_id: MeetingId, need: 'read' | 'write') =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<MeetingAccessRow>`SELECT m.visibility, a.access FROM meetings m
      LEFT JOIN meeting_access a ON a.workspace_id = m.workspace_id AND a.meeting_id = m.id AND a.principal_id = ${access.principal.id}
      WHERE m.workspace_id = ${access.workspace_id} AND m.id = ${meeting_id}`;
    const allowed =
      row !== undefined &&
      (access.meetings.kind === 'allowlist'
        ? access.meetings.meeting_ids.includes(meeting_id)
        : row.visibility === 'workspace' || (need === 'read' ? row.access !== null : row.access === 'write' || row.access === 'owner'));
    if (!allowed) return yield* new NotFound({ message: 'Meeting not found' });
  }).pipe(Effect.catchTag('SqlError', Effect.die));

export const listVisibleMeetingIds = (access: AccessScope) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { meetings } = access;
    if (meetings.kind === 'allowlist' && meetings.meeting_ids.length === 0) return [];
    const visible =
      meetings.kind === 'allowlist'
        ? sql`m.id IN ${sql.in(meetings.meeting_ids)}`
        : sql`(m.visibility = 'workspace' OR EXISTS (SELECT 1 FROM meeting_access a
            WHERE a.workspace_id = m.workspace_id AND a.meeting_id = m.id AND a.principal_id = ${access.principal.id}))`;
    const rows = yield* sql<{ id: MeetingId }>`SELECT m.id FROM meetings m WHERE m.workspace_id = ${access.workspace_id} AND ${visible} ORDER BY m.id`;
    return rows.map(row => row.id);
  });
