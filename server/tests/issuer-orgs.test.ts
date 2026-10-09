import { createHash, randomBytes } from 'node:crypto';
import { HttpServer } from '@effect/platform';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { ConfigProvider, Context, Effect, Layer, Option, Redacted } from 'effect';
import { createRemoteJWKSet, decodeJwt, type JWTVerifyGetKey } from 'jose';
import type { CustomFetch } from 'openid-client';
import { registerSanctumClient } from '../src/issuer.ts';
import { serverLayer } from '../src/main.ts';
import { McpAuthorizationServer } from '../src/mcp.ts';
import { SignInSettings } from '../src/signin.ts';
import { freshDatabase, migrateDatabase, runSql } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

const ORIGIN = 'https://sanctum.fixture.test';
const ISSUER = `${ORIGIN}/idp`;
const RESOURCE = `${ORIGIN}/mcp`;
const CALLBACK = new URL(`${ORIGIN}/auth/callback`);
const MCP_REDIRECT = 'https://client.fixture.test/callback';
const SECRET = 'fixture-secret-0123456789abcdef0123456789';
const env = { SANCTUM_EMBEDDED_ISSUER: 'better-auth', SANCTUM_OIDC_ISSUER: ISSUER, SANCTUM_MCP_RESOURCE: RESOURCE, BETTER_AUTH_SECRET: SECRET };

/**
 * The real API with the embedded issuer at `/idp`, Sanctum's registered sign-in client and the kernel
 * authenticator, on a fresh migrated database. Requests to the fixture origin go to the server's port.
 */
const selfHosted = Effect.gen(function* () {
  const database = yield* freshDatabase;
  yield* migrateDatabase(database);
  const settings = { issuer: new URL(ISSUER), resource: new URL(RESOURCE), secret: Redacted.make(SECRET) };
  const clientId = yield* registerSanctumClient(settings, database.mysql, CALLBACK);
  const served = { base: '' };
  // openid-client's options are a RequestInit whose optional fields also admit `undefined`.
  const toServer: CustomFetch = (url, options) => fetch(url.replace(ORIGIN, served.base), options as RequestInit);
  const keys: JWTVerifyGetKey = (header, token) => createRemoteJWKSet(new URL(`${served.base}/idp/jwks`))(header, token);
  const signIn = { issuer: new URL(ISSUER), clientId, clientSecret: Option.none(), redirectUri: CALLBACK, scopes: 'openid profile email', fetch: toServer };
  const layer = serverLayer({ apiPort: 0, mysql: database.mysql }, undefined, {
    signIn: Layer.succeed(SignInSettings, { client: Option.some(signIn), embeddedIssuer: 'better-auth' }),
    mcp: Layer.succeed(McpAuthorizationServer, Option.some({ resource: RESOURCE, issuer: ISSUER, keys, defaultScopes: [] })),
  });
  const address = Context.get(yield* Layer.build(layer), HttpServer.HttpServer).address;
  if (address._tag !== 'TcpAddress') throw new Error('expected TCP');
  served.base = `http://127.0.0.1:${address.port}`;
  return { base: served.base, sql: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runSql(database, effect) };
}).pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env))).pipe(ConfigProvider.orElse(ConfigProvider.fromEnv))));

type Server = Effect.Effect.Success<typeof selfHosted>;

const cookiesOf = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

/** A JSON call to the issuer as the website's Better Auth client makes it. */
async function idp(server: Server, path: string, cookie: string, body?: unknown) {
  const response = await fetch(`${server.base}/idp${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** Registers an issuer account and returns its id and the issuer session cookie a browser would hold. */
async function signUp(server: Server, name: string, email = `${name.toLowerCase()}-${randomBytes(4).toString('hex')}@fixture.test`) {
  const response = await fetch(`${server.base}/idp/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ name, email, password: 'correct horse battery staple' }),
  });
  expect(response.status).toBe(200);
  const { user } = (await response.json()) as { user: { id: string } };
  return { id: user.id, email, cookie: cookiesOf(response) };
}

/** Website sign-in through the embedded issuer with an existing issuer session; returns where it landed and the Sanctum cookies. */
async function signIn(server: Server, issuerCookie: string) {
  const started = await fetch(`${server.base}/auth/login`, { redirect: 'manual' });
  const authorize = await fetch(started.headers.get('location')!.replace(ORIGIN, server.base), { headers: { cookie: issuerCookie } });
  const { url } = (await authorize.json()) as { url: string };
  const done = await fetch(`${server.base}/auth/callback${new URL(url).search}`, { redirect: 'manual', headers: { cookie: cookiesOf(started) } });
  return { location: done.headers.get('location'), cookie: cookiesOf(done) };
}

const session = (server: Server, cookie: string) =>
  fetch(`${server.base}/api/v1/session`, { headers: { cookie } }).then(async response => ({ status: response.status, body: (await response.json()) as Record<string, any> }));

/** An MCP client's access token for the resource, authorized with the issuer session `cookie`. */
async function mcpToken(server: Server, cookie: string) {
  const registered = await idp(server, '/oauth2/register', '', { client_name: 'Fixture MCP', redirect_uris: [MCP_REDIRECT], token_endpoint_auth_method: 'none' });
  const client = registered.body['client_id'] as string;
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client,
    redirect_uri: MCP_REDIRECT,
    scope: 'openid context:read',
    resource: RESOURCE,
    state: 's',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  const consent = new URL(((await (await fetch(`${server.base}/idp/oauth2/authorize?${query}`, { headers: { cookie } })).json()) as { url: string }).url, ORIGIN);
  const accepted = await idp(server, '/oauth2/consent', cookie, { accept: true, oauth_query: consent.search.slice(1) });
  const code = new URL(accepted.body['url'] as string).searchParams.get('code')!;
  const token = await fetch(`${server.base}/idp/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: MCP_REDIRECT, client_id: client, code_verifier: verifier, resource: RESOURCE }),
  });
  return ((await token.json()) as { access_token: string }).access_token;
}

const mcpStatus = (server: Server, token: string) =>
  fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }),
  }).then(response => response.status);

/** Gives the issuer account `userId` the identity of a Sanctum principal. */
const linkIdentity = (server: Server, userId: string, principalId: string) =>
  server.sql(Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO principal_identities (issuer, subject, principal_id, verified_at) VALUES (${ISSUER}, ${userId}, ${principalId}, UTC_TIMESTAMP(6))`));

/** An owner with a Sanctum workspace and its organization, ready to invite. */
async function ownerWithTeam(server: Server) {
  const owner = await signUp(server, 'Owner');
  const [seeded] = await server.sql(seedWorkspace('Acme', ['owner']));
  const { workspace_id } = seeded!;
  await linkIdentity(server, owner.id, seeded!.principal.id);
  const created = await idp(server, '/organization/create', owner.cookie, { name: 'Team', slug: workspace_id });
  expect(created.status).toBe(200);
  return { owner, workspace_id, org: created.body };
}

/** Invites `email` as `role` and accepts with a new account of that email; returns the accept response and the invitee. */
async function join(server: Server, team: { readonly owner: { readonly cookie: string }; readonly workspace_id: string }, name: string, role = 'member') {
  const email = `${name.toLowerCase()}-${randomBytes(4).toString('hex')}@fixture.test`;
  const invited = await idp(server, '/organization/invite-member', team.owner.cookie, { email, role, organizationId: team.workspace_id });
  expect(invited.status).toBe(200);
  const invitee = await signUp(server, name, email);
  const accepted = await idp(server, '/organization/accept-invitation', invitee.cookie, { invitationId: invited.body['id'] });
  return { invitee, invitation: invited.body['id'] as string, accepted };
}

describe('self-hosted organizations', () => {
  it.scoped('an invitee becomes a Sanctum member; role changes and removal follow, and removal ends the session', () =>
    Effect.gen(function* () {
      const server = yield* selfHosted;
      yield* Effect.promise(async () => {
        const team = await ownerWithTeam(server);
        // The organization is the workspace: same id and name, linked for MCP's `org_id`.
        expect(team.org).toMatchObject({ id: team.workspace_id, name: 'Acme' });

        const { invitee, accepted } = await join(server, team, 'Grace');
        expect(accepted.status).toBe(200);
        const signedIn = await signIn(server, invitee.cookie);
        expect(signedIn.location).toBe('/');
        expect((await session(server, signedIn.cookie)).body).toMatchObject({ workspace_id: team.workspace_id, role: 'member', principal: { display_name: 'Grace' } });

        const memberId = accepted.body['member'].id as string;
        expect((await idp(server, '/organization/update-member-role', team.owner.cookie, { memberId, role: 'admin', organizationId: team.workspace_id })).status).toBe(200);
        expect((await session(server, signedIn.cookie)).body).toMatchObject({ role: 'admin' });

        expect((await idp(server, '/organization/remove-member', team.owner.cookie, { memberIdOrEmail: memberId, organizationId: team.workspace_id })).status).toBe(200);
        expect((await session(server, signedIn.cookie)).status).toBe(401);
        expect((await signIn(server, invitee.cookie)).location).toMatch(/^\/\?signin=not_member/);
      });
    }),
  );

  it.scoped('only an owner of the workspace can create its organization', () =>
    Effect.gen(function* () {
      const server = yield* selfHosted;
      yield* Effect.promise(async () => {
        const user = await signUp(server, 'Member');
        const [member] = await server.sql(seedWorkspace('Acme', ['member']));
        await linkIdentity(server, user.id, member!.principal.id);
        for (const slug of [member!.workspace_id, 'any-new-team']) {
          const refused = await idp(server, '/organization/create', user.cookie, { name: 'Team', slug });
          expect(refused, slug).toMatchObject({ status: 403, body: { message: 'Only an owner of this Sanctum workspace can set up its team' } });
        }
        const rows = await server.sql(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT (SELECT COUNT(*) FROM auth_organization) + (SELECT COUNT(*) FROM workspace_orgs) AS n`));
        expect(Number(rows[0]!['n'])).toBe(0);
      });
    }),
  );

  it.scoped('a full workspace refuses the invitation before the issuer adds the member', () =>
    Effect.gen(function* () {
      const server = yield* selfHosted;
      yield* Effect.promise(async () => {
        const team = await ownerWithTeam(server);
        await server.sql(Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE workspaces SET seat_limit = 1 WHERE id = ${team.workspace_id}`));
        const { invitation, accepted } = await join(server, team, 'Linus');
        expect(accepted).toMatchObject({ status: 403, body: { message: 'Workspace seat limit of 1 reached' } });
        const listed = await idp(server, `/organization/get-full-organization?organizationId=${team.workspace_id}`, team.owner.cookie);
        expect(listed.body['members']).toHaveLength(1);
        expect(listed.body['invitations']).toEqual([expect.objectContaining({ id: invitation, status: 'pending' })]);
      });
    }),
  );

  it.scoped('a session with the invited email cannot list its invitations to learn the id', () =>
    Effect.gen(function* () {
      const server = yield* selfHosted;
      yield* Effect.promise(async () => {
        const team = await ownerWithTeam(server);
        const email = `squat-${randomBytes(4).toString('hex')}@fixture.test`;
        const invited = await idp(server, '/organization/invite-member', team.owner.cookie, { email, role: 'member', organizationId: team.workspace_id });
        const squatter = await signUp(server, 'Squatter', email);
        const listed = await fetch(`${server.base}/idp/organization/list-user-invitations`, { headers: { origin: ORIGIN, cookie: squatter.cookie } });
        expect(listed.status).toBe(404);
        expect(await listed.text()).not.toContain(invited.body['id']);
        // The id from the link still accepts.
        expect((await idp(server, '/organization/accept-invitation', squatter.cookie, { invitationId: invited.body['id'] })).status).toBe(200);
      });
    }),
  );

  it.scoped('only owners and admins see pending invitations, and none can name the owner role', () =>
    Effect.gen(function* () {
      const server = yield* selfHosted;
      yield* Effect.promise(async () => {
        const team = await ownerWithTeam(server);
        const member = (await join(server, team, 'Mia')).invitee;
        const admin = (await join(server, team, 'Ava', 'admin')).invitee;
        const pending = await idp(server, '/organization/invite-member', team.owner.cookie, { email: `pending-${randomBytes(4).toString('hex')}@fixture.test`, role: 'admin', organizationId: team.workspace_id });
        const full = `/organization/get-full-organization?organizationId=${team.workspace_id}`;
        // Better Auth also lists the accepted invitations of the two joiners; only the pending one still carries a usable id.
        for (const manager of [team.owner, admin]) {
          const invitations = (await idp(server, full, manager.cookie)).body['invitations'] as Array<{ id: string; status: string }>;
          expect(invitations.filter(({ status }) => status === 'pending')).toEqual([expect.objectContaining({ id: pending.body['id'] })]);
        }
        const seen = await idp(server, full, member.cookie);
        expect(seen.body['members']).toHaveLength(3);
        expect(seen.body['invitations']).toEqual([]);
        for (const person of [team.owner, admin, member]) {
          const listed = await fetch(`${server.base}/idp/organization/list-invitations?organizationId=${team.workspace_id}`, { headers: { origin: ORIGIN, cookie: person.cookie } });
          expect(listed.status).toBe(404);
        }
        const owner = await idp(server, '/organization/invite-member', team.owner.cookie, { email: 'boss@fixture.test', role: 'owner', organizationId: team.workspace_id });
        expect(owner.status).toBe(403);
        expect(owner.body).toMatchObject({ message: expect.stringContaining('changing a member') });
      });
    }),
  );

  it.scoped('sign-in repairs a membership whose Sanctum side failed, and MCP org_id selects the workspace', () =>
    Effect.gen(function* () {
      const server = yield* selfHosted;
      yield* Effect.promise(async () => {
        const team = await ownerWithTeam(server);
        const { invitee } = await join(server, team, 'Ada');
        // As if the hook after the accept had failed: Better Auth has the member, Sanctum does not.
        await server.sql(Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE workspace_members SET revoked_at = UTC_TIMESTAMP(6) WHERE workspace_id = ${team.workspace_id} AND role = 'member'`));
        const signedIn = await signIn(server, invitee.cookie);
        expect(signedIn.location).toBe('/');
        expect((await session(server, signedIn.cookie)).body).toMatchObject({ workspace_id: team.workspace_id, role: 'member' });

        // A second membership: only the token's `org_id` (the accept made the organization active) picks one.
        const principal = (await session(server, signedIn.cookie)).body['principal'].id;
        const [other] = await server.sql(seedWorkspace('Other', ['owner']));
        await server.sql(Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO workspace_members (workspace_id, principal_id, role, created_at) VALUES (${other!.workspace_id}, ${principal}, 'member', UTC_TIMESTAMP(6))`));
        const selected = await mcpToken(server, invitee.cookie);
        expect(decodeJwt(selected)['org_id']).toBe(team.workspace_id);
        expect(await mcpStatus(server, selected)).toBe(200);

        expect((await idp(server, '/organization/set-active', invitee.cookie, { organizationId: null })).status).toBe(200);
        const unselected = await mcpToken(server, invitee.cookie);
        expect(decodeJwt(unselected)['org_id']).toBeUndefined();
        expect(await mcpStatus(server, unselected)).toBe(403);
      });
    }),
  );
});
