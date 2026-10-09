import { createHash, randomBytes } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Effect, Option, Redacted } from 'effect';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { createConnection } from 'mysql2/promise';
import { inject } from 'vitest';
import { dbLayer } from '../src/db.ts';
import { createIssuer, registerSanctumClient } from '../src/issuer.ts';
import { loadMigrations, migrate } from '../src/migrate.ts';
import { createTestDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';
import { serveFake } from './support/serve.ts';

const ORIGIN = 'https://sanctum.fixture.test';
const ISSUER = `${ORIGIN}/idp`;
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = 'https://client.fixture.test/callback';
const SECRET = 'fixture-secret-0123456789abcdef0123456789';
const env = { SANCTUM_EMBEDDED_ISSUER: 'better-auth', SANCTUM_OIDC_ISSUER: ISSUER, SANCTUM_MCP_RESOURCE: RESOURCE, BETTER_AUTH_SECRET: SECRET };

/** JWKS of the server under test, whose port is known only after it starts. */
const served = { url: '' };
const keys: JWTVerifyGetKey = (header, token) => createRemoteJWKSet(new URL(`${served.url}/idp/jwks`))(header, token);
const serveIssuer = Effect.tap(serveFake(Option.some({ resource: RESOURCE, issuer: ISSUER, keys, defaultScopes: [] }), env), ({ url }) => {
  served.url = url;
});

/** Sends one request to the issuer; the tests pass either a real HTTP server or the issuer's handler. */
type Send = (path: string, init?: RequestInit) => Promise<Response>;

/** Registers a user and returns its subject plus the issuer session cookie a browser would hold. */
async function signUp(send: Send) {
  const response = await send('/idp/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ name: 'Fixture Owner', email: `owner-${randomBytes(4).toString('hex')}@fixture.test`, password: 'correct horse battery staple' }),
  });
  expect(response.status).toBe(200);
  const { user } = (await response.json()) as { user: { id: string } };
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  return { user: user.id, cookie };
}

async function authorize(send: Send, cookie: string, client: string, params: Record<string, string>) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client,
    redirect_uri: REDIRECT,
    state: 'fixture-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...params,
  });
  // Browser-like (`sec-fetch-mode: cors`) requests make Better Auth answer with the redirect as JSON.
  const started = await send(`/idp/oauth2/authorize?${query}`, { headers: { cookie } });
  const { url: consentPage } = (await started.json()) as { url: string };
  const consent = new URL(consentPage, ORIGIN);
  expect(`${consent.origin}${consent.pathname}`).toBe(`${ORIGIN}/consent`);
  const accepted = await send('/idp/oauth2/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify({ accept: true, oauth_query: consent.search.slice(1) }),
  });
  const { url: back } = (await accepted.json()) as { url: string };
  const code = new URL(back).searchParams.get('code')!;
  const token = await send('/idp/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client, code_verifier: verifier, ...(params['resource'] ? { resource: params['resource'] } : {}) }),
  });
  expect(token.status).toBe(200);
  return (await token.json()) as { access_token: string; id_token?: string; refresh_token?: string };
}

describe('embedded Better Auth issuer', () => {
  it.scoped('fits migration 011: Better Auth finds no schema drift once Sanctum has migrated', () =>
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
      // Better Auth caches the result per pool, so each check uses its own issuer.
      const check = Effect.acquireUseRelease(
        Effect.sync(() => createIssuer({ issuer: new URL(ISSUER), resource: new URL(RESOURCE), secret: Redacted.make(SECRET) }, database.mysql)),
        ({ auth }) => Effect.promise(async () => (await auth.$context).checkSchema!()!.then(() => 'current', (error: Error) => error.message)),
        ({ pool }) => Effect.promise(() => pool.end()),
      );
      expect(yield* check).toMatch(/Missing tables/);
      yield* Effect.provide(migrate(loadMigrations()), dbLayer(database.mysql));
      expect(yield* check).toBe('current');
    }),
  );

  it.scoped('publishes OIDC and RFC 8414 discovery with PKCE and CIMD at /idp', () =>
    Effect.gen(function* () {
      const { url } = yield* serveIssuer;
      const oidc = yield* Effect.promise(() => fetch(`${url}/idp/.well-known/openid-configuration`).then(r => r.json() as Promise<Record<string, unknown>>));
      expect(oidc).toMatchObject({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true });
      expect(oidc['scopes_supported']).toEqual(['openid', 'profile', 'email', 'offline_access', 'context:read', 'context:write', 'recordings:read', 'actions:request', 'actions:execute']);
      const oauth = yield* Effect.promise(() => fetch(`${url}/.well-known/oauth-authorization-server/idp`).then(r => r.json() as Promise<Record<string, unknown>>));
      expect(oauth['issuer']).toBe(ISSUER);
    }),
  );

  it.scoped('gives a DCR client an MCP token Sanctum accepts, and an ID token with the same subject', () =>
    Effect.gen(function* () {
      const { url, db } = yield* serveIssuer;
      const send: Send = (path, init) => fetch(`${url}${path}`, init);
      const { user, cookie } = yield* Effect.promise(() => signUp(send));
      const registered = yield* Effect.promise(() =>
        send('/idp/oauth2/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_name: 'Fixture MCP client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
        }).then(r => r.json() as Promise<{ client_id: string }>),
      );

      const mcp = yield* Effect.promise(() => authorize(send, cookie, registered.client_id, { scope: 'openid context:read context:write', resource: RESOURCE }));
      // The resource's allowed scopes bound the access token; `openid` stays with the ID token.
      expect(decodeJwt(mcp.access_token)).toMatchObject({ iss: ISSUER, sub: user, scope: 'context:read context:write' });

      // Sign-in links the subject to a member; here the fixture does it directly.
      const [member] = yield* Effect.provide(seedWorkspace('Embedded', ['member']), db);
      yield* Effect.provide(
        Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO principal_identities (issuer, subject, principal_id, verified_at) VALUES (${ISSUER}, ${user}, ${member!.principal.id}, UTC_TIMESTAMP(6))`),
        db,
      );
      const client = new Client({ name: 'issuer-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${mcp.access_token}` } } });
      yield* Effect.acquireRelease(
        Effect.promise(() => client.connect(transport as Transport)),
        () => Effect.promise(() => client.close()),
      );
      const listed = yield* Effect.promise(() => client.callTool({ name: 'list_meetings', arguments: {} }));
      expect(listed.isError).toBeFalsy();
      expect(listed.structuredContent).toMatchObject({ meetings: [] });

      const login = yield* Effect.promise(() => authorize(send, cookie, registered.client_id, { scope: 'openid profile', nonce: 'fixture-nonce' }));
      const { payload } = yield* Effect.promise(() => jwtVerify(login.id_token!, keys, { issuer: ISSUER, audience: registered.client_id }));
      expect(payload).toMatchObject({ sub: user, nonce: 'fixture-nonce' });
    }),
  );

  it.scoped('registers a loopback-only DCR client without application_type as native and leaves other requests unchanged', () =>
    Effect.gen(function* () {
      const { url } = yield* serveIssuer;
      const register = (body: Record<string, unknown>) =>
        Effect.promise(async () => {
          const response = await fetch(`${url}/idp/oauth2/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ client_name: 'Fixture', token_endpoint_auth_method: 'none', ...body }),
          });
          return { status: response.status, body: (await response.json()) as Record<string, unknown> };
        });

      for (const redirect of ['http://localhost:8123/callback', 'http://127.0.0.1:8123/callback', 'http://[::1]:8123/callback']) {
        const accepted = yield* register({ redirect_uris: [redirect] });
        expect(accepted.status, redirect).toBe(201);
        expect(accepted.body['application_type'], redirect).toBe('native');
      }
      const remote = yield* register({ redirect_uris: ['http://evil.fixture.test/callback'] });
      expect(remote.status).toBe(400);
      expect(remote.body['error']).toBe('invalid_redirect_uri');
      const mixed = yield* register({ redirect_uris: ['http://127.0.0.1:8123/callback', 'https://client.fixture.test/callback'] });
      expect(mixed.body['error']).toBe('invalid_redirect_uri');
      const web = yield* register({ application_type: 'web', redirect_uris: ['http://127.0.0.1:8123/callback'] });
      expect(web.body['error']).toBe('invalid_redirect_uri');
    }),
  );

  it.scoped('offers a scopeless authorization no action scopes, while an explicit request still gets them', () =>
    Effect.gen(function* () {
      const { url } = yield* serveIssuer;
      const send: Send = (path, init) => fetch(`${url}${path}`, init);
      const { cookie } = yield* Effect.promise(() => signUp(send));
      const register = (scope?: string) =>
        Effect.promise(async () => {
          const response = await send('/idp/oauth2/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ client_name: 'Fixture', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...(scope ? { scope } : {}) }),
          });
          return (await response.json()) as { client_id: string };
        });

      const plain = yield* register();
      expect(plain.client_id).toBeDefined();
      const granted = yield* Effect.promise(() => authorize(send, cookie, plain.client_id, { resource: RESOURCE }));
      expect(decodeJwt(granted.access_token)['scope']).toBe('context:read context:write recordings:read');

      const explicit = yield* register('openid actions:request');
      const actions = yield* Effect.promise(() => authorize(send, cookie, explicit.client_id, { scope: 'openid actions:request', resource: RESOURCE }));
      expect(decodeJwt(actions.access_token)['scope']).toBe('actions:request');
    }),
  );

  it.scoped('issuer:client registers a first-party public PKCE client for the redirect, without consent', () =>
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
      yield* Effect.provide(migrate(loadMigrations()), dbLayer(database.mysql));
      const redirect = new URL('https://sanctum.fixture.test/auth/callback');
      const settings = { issuer: new URL(ISSUER), resource: new URL(RESOURCE), secret: Redacted.make(SECRET) };
      const clientId = yield* registerSanctumClient(settings, database.mysql, redirect);
      const rows = yield* Effect.provide(
        Effect.flatMap(SqlClient.SqlClient, sql => sql<{ clientId: string; clientSecret: string | null; skipConsent: number; requirePKCE: number; tokenEndpointAuthMethod: string; redirectUris: unknown }>`SELECT clientId, clientSecret, skipConsent, requirePKCE, tokenEndpointAuthMethod, redirectUris FROM auth_oauth_client`),
        dbLayer(database.mysql),
      );
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({ clientId, clientSecret: null, skipConsent: 1, requirePKCE: 1, tokenEndpointAuthMethod: 'none' });
      expect(typeof row!.redirectUris === 'string' ? JSON.parse(row!.redirectUris) : row!.redirectUris).toEqual([redirect.href]);
    }),
  );

  it.scoped('completes an authorization for a URL-style CIMD client id', () =>
    Effect.gen(function* () {
      const clientId = 'https://client.fixture.test/oauth/client-metadata.json';
      const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
      yield* Effect.provide(migrate(loadMigrations()), dbLayer(database.mysql));
      const document = { client_id: clientId, client_name: 'Fixture CIMD client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' };
      const fetchMetadata = async () => new Response(JSON.stringify(document), { headers: { 'content-type': 'application/json' } });
      const { auth, pool } = createIssuer({ issuer: new URL(ISSUER), resource: new URL(RESOURCE), secret: Redacted.make(SECRET) }, database.mysql, fetchMetadata);
      yield* Effect.addFinalizer(() => Effect.promise(() => pool.end()));
      // A browser-like fetch: Better Auth answers a `cors` navigation with the redirect as JSON.
      const send: Send = (path, init) => auth.handler(new Request(`${ORIGIN}${path}`, { ...init, headers: { ...(init?.headers as Record<string, string>), 'sec-fetch-mode': 'cors' } }));

      const { user, cookie } = yield* Effect.promise(() => signUp(send));
      const token = yield* Effect.promise(() => authorize(send, cookie, clientId, { scope: 'openid offline_access context:read', resource: RESOURCE }));
      expect(decodeJwt(token.access_token)).toMatchObject({ iss: ISSUER, sub: user, scope: 'context:read' });
      expect(token.refresh_token).toBeDefined();
      // A resource-bound JWT access token is not stored; only the opaque one from a resource-less grant is.
      yield* Effect.promise(() => authorize(send, cookie, clientId, { scope: 'openid profile' }));
      const stored = (table: string) => Effect.promise(() => pool.query(`SELECT DISTINCT clientId FROM ${table}`).then(([rows]) => rows));
      for (const table of ['auth_oauth_consent', 'auth_oauth_access_token', 'auth_oauth_refresh_token']) {
        expect(yield* stored(table), table).toEqual([{ clientId }]);
      }
    }),
  );

  it.effect('closes its own pool with the server scope', () =>
    Effect.gen(function* () {
      const database = yield* Effect.scoped(
        Effect.gen(function* () {
          const { url, db } = yield* serveIssuer;
          // Touches the issuer's pool through a database read.
          expect((yield* Effect.promise(() => fetch(`${url}/idp/jwks`))).status).toBe(200);
          const rows = yield* Effect.provide(Effect.flatMap(SqlClient.SqlClient, sql => sql<{ name: string }>`SELECT DATABASE() AS name`), db);
          return rows[0]!.name;
        }),
      );
      const admin = yield* Effect.promise(() => createConnection(inject('mysqlAdminUrl')));
      const open = () => admin.query('SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB = ?', [database]).then(([rows]) => (rows as Array<{ n: number }>)[0]!.n);
      yield* Effect.promise(() => expect.poll(open, { timeout: 5_000 }).toBe(0));
      yield* Effect.promise(() => admin.end());
    }),
  );
});
