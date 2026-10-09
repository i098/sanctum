import { createHash, randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import type { AccessScope } from '@sanctum/contracts';
import { Effect, Layer, Option } from 'effect';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CustomFetch } from 'openid-client';
import { linkIdentity, openSession } from '../src/auth.ts';
import { createOwner, type OwnerInput } from '../src/owner.ts';
import { type SignIn, SignInSettings } from '../src/signin.ts';
import { serveApiWithDb } from './http-server.ts';
import { seedWorkspace } from './support/fixtures.ts';

const ISSUER = 'https://issuer.fixture.test';
const CLIENT_ID = 'sanctum-fixture';
const { publicKey, privateKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'fixture' };

interface Grant {
  readonly sub: string;
  readonly nonce?: string;
  readonly iss?: string;
  readonly aud?: string;
  readonly exp?: number;
  readonly name?: string;
  /** Replaces the PKCE challenge the issuer binds to the code. */
  readonly challenge?: string;
}

interface FixtureIssuer {
  readonly fetch: CustomFetch;
  readonly authorize: (location: string, grant: Grant) => Promise<URLSearchParams>;
}

/** In-process issuer behind openid-client's fetch: discovery, JWKS and a token endpoint that checks PKCE. */
const fixtureIssuer = (): FixtureIssuer => {
  const codes = new Map<string, { challenge: string | null; idToken: string }>();
  const fetch: CustomFetch = async (url, options) => {
    const { pathname } = new URL(url);
    if (pathname === '/.well-known/openid-configuration') {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (pathname === '/jwks') return Response.json({ keys: [jwk] });
    const body = new URLSearchParams(options.body as URLSearchParams);
    const grant = codes.get(body.get('code') ?? '');
    codes.delete(body.get('code') ?? '');
    const verifier = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
    if (pathname !== '/token' || grant === undefined || verifier !== grant.challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    return Response.json({ access_token: randomUUID(), token_type: 'Bearer', id_token: grant.idToken });
  };
  /** What the issuer does once the user signs in: a code bound to the request's challenge, and the callback query. */
  const authorize = async (location: string, grant: Grant) => {
    const request = new URL(location).searchParams;
    expect(request.get('client_id')).toBe(CLIENT_ID);
    const idToken = await new SignJWT({ nonce: grant.nonce ?? request.get('nonce'), ...(grant.name ? { name: grant.name } : {}) })
      .setProtectedHeader({ alg: 'ES256', kid: 'fixture' })
      .setIssuer(grant.iss ?? ISSUER)
      .setSubject(grant.sub)
      .setAudience(grant.aud ?? CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(grant.exp ?? Math.floor(Date.now() / 1000) + 300)
      .sign(privateKey);
    const code = randomUUID();
    codes.set(code, { challenge: grant.challenge ?? request.get('code_challenge'), idToken });
    return new URLSearchParams({ code, state: request.get('state')!, iss: ISSUER });
  };
  return { fetch, authorize };
};

/** The real API with the kernel authenticator, plus SQL on the same disposable database. */
const withServer = (client: Option.Option<SignIn>) =>
  serveApiWithDb({ overrides: { signIn: Layer.succeed(SignInSettings, { client, embeddedIssuer: null }) } });

const configured = () => {
  const issuer = fixtureIssuer();
  const client: SignIn = {
    issuer: new URL(ISSUER),
    clientId: CLIENT_ID,
    clientSecret: Option.none(),
    redirectUri: new URL('https://sanctum.fixture.test/auth/callback'),
    scopes: 'openid profile email',
    fetch: issuer.fetch,
  };
  return { issuer, client: Option.some(client) };
};

const get = (url: string, cookie = '', init: RequestInit = {}) => fetch(url, { redirect: 'manual', ...init, headers: { cookie, ...init.headers } });
const cookieValue = (response: Response, name: string) =>
  response.headers.getSetCookie().find(cookie => cookie.startsWith(`${name}=`))?.split(';')[0]!.slice(name.length + 1);

/** Starts a flow, lets the fixture issuer answer with `grant`, then calls back; `tamper` edits the callback query. */
const signIn = async (base: string, issuer: FixtureIssuer, grant: Grant, path = '/auth/login', tamper = (_: URLSearchParams) => {}) => {
  const started = await get(`${base}${path}`);
  expect(started.status).toBe(302);
  const query = await issuer.authorize(started.headers.get('location')!, grant);
  tamper(query);
  return get(`${base}/auth/callback?${query}`, `sanctum_oidc=${cookieValue(started, 'sanctum_oidc')}`);
};

const identify = (access: AccessScope, subject = `sub-${access.principal.id}`) =>
  Effect.as(linkIdentity({ issuer: ISSUER, subject, principal_id: access.principal.id }), subject);
const sessionCount = Effect.flatMap(SqlClient.SqlClient, sql => sql<{ n: number }>`SELECT COUNT(*) AS n FROM browser_sessions`).pipe(Effect.map(([row]) => Number(row!.n)));

describe('OIDC sign-in', () => {
  it.scoped('signs a known identity in with flagged cookies and signs it out', () =>
    Effect.gen(function* () {
      const { issuer, client } = configured();
      const { base, db } = yield* withServer(client);
      const [owner] = yield* Effect.provide(seedWorkspace('Acme', ['owner']), db);
      const subject = yield* Effect.provide(identify(owner!), db);

      const started = yield* Effect.promise(() => get(`${base}/auth/login?return_to=${encodeURIComponent('/meetings/1?tab=notes')}`));
      const authorize = new URL(started.headers.get('location')!);
      expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/authorize`);
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      expect(started.headers.getSetCookie()).toEqual([expect.stringMatching(/^sanctum_oidc=[^;]+; Max-Age=600; .*Path=\/auth; HttpOnly; Secure; SameSite=Lax$/)]);

      const query = yield* Effect.promise(() => issuer.authorize(authorize.href, { sub: subject, name: 'Ada Owner' }));
      const done = yield* Effect.promise(() => get(`${base}/auth/callback?${query}`, `sanctum_oidc=${cookieValue(started, 'sanctum_oidc')}`));
      expect(done.status).toBe(302);
      expect(done.headers.get('location')).toBe('/meetings/1?tab=notes');
      const cookies = done.headers.getSetCookie();
      expect(cookies).toEqual([
        expect.stringMatching(/^sanctum_session=[^;]+; Path=\/; Expires=[^;]+; HttpOnly; Secure; SameSite=Lax$/),
        expect.stringMatching(/^sanctum_csrf=[^;]+; Path=\/; Expires=[^;]+; Secure; SameSite=Strict$/),
        'sanctum_oidc=; Max-Age=0; Path=/auth; HttpOnly; Secure; SameSite=Lax',
      ]);
      const session = `sanctum_session=${cookieValue(done, 'sanctum_session')}`;
      const csrf = cookieValue(done, 'sanctum_csrf')!;

      const access = yield* Effect.promise(() => get(`${base}/api/v1/session`, session).then(r => r.json()));
      expect(access).toMatchObject({ workspace_id: owner!.workspace_id, role: 'owner', principal: { id: owner!.principal.id, display_name: 'Ada Owner' } });

      expect((yield* Effect.promise(() => get(`${base}/auth/logout`, session, { method: 'POST' }))).status).toBe(403);
      const out = yield* Effect.promise(() => get(`${base}/auth/logout`, session, { method: 'POST', headers: { 'x-csrf-token': csrf } }));
      expect(out.status).toBe(204);
      expect(out.headers.getSetCookie()).toEqual(expect.arrayContaining([expect.stringMatching(/^sanctum_session=; Max-Age=0/), expect.stringMatching(/^sanctum_csrf=; Max-Age=0/)]));
      expect((yield* Effect.promise(() => get(`${base}/api/v1/session`, session))).status).toBe(401);
    }),
  );

  it.scoped('sends only local paths back after sign-in', () =>
    Effect.gen(function* () {
      const { issuer, client } = configured();
      const { base, db } = yield* withServer(client);
      const [owner] = yield* Effect.provide(seedWorkspace('Acme', ['owner']), db);
      const sub = yield* Effect.provide(identify(owner!), db);
      for (const returnTo of ['/.//evil.com', '/..//evil.com', '/a/..//evil.com', '//evil.com', '/\\evil.com', 'https://evil.com/x']) {
        const done = yield* Effect.promise(() => signIn(base, issuer, { sub }, `/auth/login?return_to=${encodeURIComponent(returnTo)}`));
        expect([done.status, done.headers.get('location')]).toEqual([302, '/']);
      }
    }),
  );

  it.scoped('opens no session for a wrong state, nonce, issuer, audience, expiry or PKCE verifier', () =>
    Effect.gen(function* () {
      const { issuer, client } = configured();
      const { base, db } = yield* withServer(client);
      const [owner] = yield* Effect.provide(seedWorkspace('Acme', ['owner']), db);
      const sub = yield* Effect.provide(identify(owner!), db);
      const cases: Array<[Grant, (query: URLSearchParams) => void]> = [
        [{ sub }, query => query.set('state', 'forged')],
        [{ sub, nonce: 'replayed' }, () => {}],
        [{ sub, iss: 'https://other-issuer.test' }, () => {}],
        [{ sub, aud: 'another-client' }, () => {}],
        [{ sub, exp: Math.floor(Date.now() / 1000) - 600 }, () => {}],
        [{ sub, challenge: 'not-the-challenge-sanctum-sent' }, () => {}],
      ];
      for (const [grant, tamper] of cases) {
        const response = yield* Effect.promise(() => signIn(base, issuer, grant, '/auth/login', tamper));
        expect([response.status, response.headers.get('location')]).toEqual([302, '/?signin=failed']);
        expect(cookieValue(response, 'sanctum_session')).toBeUndefined();
      }
      // A callback without the flow cookie (another browser) fails the same way.
      expect((yield* Effect.promise(() => get(`${base}/auth/callback?code=x&state=y`))).headers.get('location')).toBe('/?signin=failed');
      expect(yield* Effect.provide(sessionCount, db)).toBe(0);
    }),
  );

  it.scoped('refuses unknown identities, ended memberships and disabled principals, and asks which workspace', () =>
    Effect.gen(function* () {
      const { issuer, client } = configured();
      const { base, db } = yield* withServer(client);
      const location = (grant: Grant, path?: string) => Effect.promise(() => signIn(base, issuer, grant, path).then(r => r.headers.get('location')));
      expect(yield* location({ sub: 'user_new' })).toBe(`/?signin=not_member&issuer=${encodeURIComponent(ISSUER)}&subject=user_new`);

      const [revoked, disabled] = yield* Effect.provide(seedWorkspace('Ended', ['member', 'member']), db);
      const revokedSub = yield* Effect.provide(identify(revoked!), db);
      const disabledSub = yield* Effect.provide(identify(disabled!), db);
      yield* Effect.provide(
        Effect.flatMap(SqlClient.SqlClient, sql =>
          Effect.zip(
            sql`UPDATE workspace_members SET revoked_at = UTC_TIMESTAMP(6) WHERE principal_id = ${revoked!.principal.id}`,
            sql`UPDATE principals SET disabled_at = UTC_TIMESTAMP(6) WHERE id = ${disabled!.principal.id}`,
          ),
        ),
        db,
      );
      expect(yield* location({ sub: revokedSub })).toMatch(/^\/\?signin=not_member&/);
      expect(yield* location({ sub: disabledSub })).toMatch(/^\/\?signin=not_member&/);
      expect(yield* Effect.provide(sessionCount, db)).toBe(0);

      // One person in two workspaces picks one through `?workspace=`.
      const [first] = yield* Effect.provide(seedWorkspace('First', ['member']), db);
      const [second] = yield* Effect.provide(seedWorkspace('Second', ['owner']), db);
      const sub = yield* Effect.provide(identify(first!), db);
      yield* Effect.provide(
        Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE workspace_members SET principal_id = ${first!.principal.id} WHERE workspace_id = ${second!.workspace_id}`),
        db,
      );
      const ids = [first!.workspace_id, second!.workspace_id].sort();
      expect(yield* location({ sub })).toBe(`/?signin=choose_workspace&workspace=${ids[0]}&workspace=${ids[1]}`);
      const chosen = yield* Effect.promise(() => signIn(base, issuer, { sub }, `/auth/login?workspace=${second!.workspace_id}`));
      const access = yield* Effect.promise(() => get(`${base}/api/v1/session`, `sanctum_session=${cookieValue(chosen, 'sanctum_session')}`).then(r => r.json()));
      expect(access).toMatchObject({ workspace_id: second!.workspace_id, role: 'owner' });
    }),
  );

  it.scoped('links a sign-in to the current principal only', () =>
    Effect.gen(function* () {
      const { issuer, client } = configured();
      const { base, db } = yield* withServer(client);
      const [owner, other] = yield* Effect.provide(seedWorkspace('Acme', ['owner', 'member']), db);
      const takenSub = yield* Effect.provide(identify(other!), db);
      // The secret-link owner session; its principal has no identity yet.
      const opened = yield* Effect.provide(openSession({ workspace_id: owner!.workspace_id, principal_id: owner!.principal.id }), db);
      const session = `sanctum_session=${opened.token}`;

      expect((yield* Effect.promise(() => get(`${base}/auth/link`, session, { method: 'POST' }))).status).toBe(403);
      const link = (sub: string) =>
        Effect.promise(async () => {
          const started = await get(`${base}/auth/link?return_to=/settings`, session, { method: 'POST', headers: { 'x-csrf-token': opened.csrf_token } });
          expect(started.status).toBe(200);
          const { url } = (await started.json()) as { url: string };
          const query = await issuer.authorize(url, { sub });
          const flow = `sanctum_oidc=${cookieValue(started, 'sanctum_oidc')}`;
          return get(`${base}/auth/callback?${query}`, `${session}; ${flow}`).then(r => r.headers.get('location'));
        });

      expect(yield* link(takenSub)).toBe('/?signin=already_linked');
      expect(yield* link('user_owner')).toBe('/settings');
      const signedIn = yield* Effect.promise(() => signIn(base, issuer, { sub: 'user_owner' }));
      const access = yield* Effect.promise(() => get(`${base}/api/v1/session`, `sanctum_session=${cookieValue(signedIn, 'sanctum_session')}`).then(r => r.json()));
      expect(access).toMatchObject({ principal: { id: owner!.principal.id }, role: 'owner' });
      const [bound] = yield* Effect.provide(
        Effect.flatMap(SqlClient.SqlClient, sql => sql<{ principal_id: string }>`SELECT principal_id FROM principal_identities WHERE subject = ${takenSub}`),
        db,
      );
      expect(bound!.principal_id).toBe(other!.principal.id);
    }),
  );

  it.scoped('creates the first owner atomically and refuses a second workspace', () =>
    Effect.gen(function* () {
      const { issuer, client } = configured();
      const { base, db } = yield* withServer(client);
      const count = Effect.flatMap(SqlClient.SqlClient, sql =>
        sql<{ w: number; p: number; i: number; m: number }>`SELECT (SELECT COUNT(*) FROM workspaces) AS w, (SELECT COUNT(*) FROM principals) AS p,
          (SELECT COUNT(*) FROM principal_identities) AS i, (SELECT COUNT(*) FROM workspace_members WHERE role = 'owner') AS m`,
      ).pipe(Effect.map(([row]) => [row!.w, row!.p, row!.i, row!.m].map(Number)));
      const owner = (subject: string, workspace: OwnerInput['workspace']) =>
        Effect.provide(createOwner({ issuer: ISSUER, subject, display_name: 'First Owner', workspace }), db);

      expect(yield* Effect.flip(owner('user_x', { name: 'Acme', timezone: 'Mars/Olympus' }))).toMatchObject({ _tag: 'OwnerRefused' });
      const created = yield* owner('user_first', { name: 'Acme', timezone: 'Europe/Berlin' });
      expect(yield* Effect.provide(count, db)).toEqual([1, 1, 1, 1]);
      expect(yield* Effect.flip(owner('user_second', { name: 'Other', timezone: 'UTC' }))).toMatchObject({ _tag: 'OwnerRefused' });
      // A duplicate identity fails after the principal insert; the transaction leaves nothing behind.
      yield* Effect.flip(owner('user_first', { id: created.workspace_id }));
      expect(yield* Effect.provide(count, db)).toEqual([1, 1, 1, 1]);
      yield* owner('user_cofounder', { id: created.workspace_id });
      expect(yield* Effect.provide(count, db)).toEqual([1, 2, 2, 2]);

      const signedIn = yield* Effect.promise(() => signIn(base, issuer, { sub: 'user_first' }));
      const access = yield* Effect.promise(() => get(`${base}/api/v1/session`, `sanctum_session=${cookieValue(signedIn, 'sanctum_session')}`).then(r => r.json()));
      expect(access).toMatchObject({ workspace_id: created.workspace_id, principal: { id: created.principal_id }, role: 'owner' });
    }),
  );

  it.scoped('reports sign-in as unavailable while no issuer is configured', () =>
    Effect.gen(function* () {
      const { base } = yield* withServer(Option.none());
      expect(yield* Effect.promise(() => fetch(`${base}/auth/config`).then(r => r.json()))).toEqual({ sign_in: false, embedded_issuer: null });
      const login = yield* Effect.promise(() => get(`${base}/auth/login`));
      expect(login.status).toBe(503);
      expect(yield* Effect.promise(() => login.json())).toMatchObject({ code: 'unavailable', retryable: false });
      expect((yield* Effect.promise(() => get(`${base}/auth/callback?code=x&state=y`))).headers.get('location')).toBe('/?signin=unconfigured');
    }),
  );
});
