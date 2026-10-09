import { createHash, randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, JobId, type WorkspaceId } from '@sanctum/contracts';
import { Effect, Layer, Option, Redacted } from 'effect';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CustomFetch } from 'openid-client';
import { linkIdentity, openSession } from '../src/auth.ts';
import { claimJob } from '../src/job-runner.ts';
import { enqueueJob } from '../src/jobs.ts';
import { armWorkosSync, syncWorkosEvents, WorkosOrganizations, workosSettings } from '../src/org-sync.ts';
import { createOwner, type OwnerInput } from '../src/owner.ts';
import { type SignIn, SignInSettings } from '../src/signin.ts';
import { purgeWorkspace } from '../src/workspaces.ts';
import { serveApiWithDb } from './http-server.ts';
import { seedWorkspace } from './support/fixtures.ts';
import { memoryObjectStore } from './support/object-store.ts';

const ISSUER = 'https://issuer.fixture.test';
const CLIENT_ID = 'sanctum-fixture';
const linkWorkspaceOrg = (link: { readonly workspace_id: WorkspaceId; readonly issuer: string; readonly org_id: string }) =>
  Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO workspace_orgs (issuer, org_id, workspace_id, created_at) VALUES (${link.issuer}, ${link.org_id}, ${link.workspace_id}, UTC_TIMESTAMP(6))`);
const { publicKey, privateKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'fixture' };

interface Grant {
  readonly sub: string;
  readonly nonce?: string;
  readonly iss?: string;
  readonly aud?: string;
  readonly exp?: number;
  readonly name?: string;
  readonly email?: string;
  readonly given_name?: string;
  readonly family_name?: string;
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
    const claims = { nonce: grant.nonce ?? request.get('nonce'), ...(grant.name ? { name: grant.name } : {}), ...(grant.email ? { email: grant.email } : {}), ...(grant.given_name ? { given_name: grant.given_name } : {}), ...(grant.family_name ? { family_name: grant.family_name } : {}) };
    const idToken = await new SignJWT(claims)
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

type Status = 'active' | 'inactive' | 'pending';
interface Membership {
  user_id: string;
  organization_id: string;
  status: Status;
  role: { slug: string };
}

const API_KEY = 'sk_test_fixture';

/** In-memory WorkOS behind the client's fetch (organizations, memberships, the event log); no request leaves the process. */
const fakeWorkos = () => {
  const organizations: Array<{ id: string; name: string; external_id: string | null }> = [];
  const memberships: Array<Membership> = [];
  const events: Array<{ id: string; event: string; data: unknown }> = [];
  /** `METHOD /path?query` of every request, in order. */
  const requests: Array<string> = [];
  /** `METHOD /path` answered once with a 500 before the call is made. */
  const failOnce = new Set<string>();
  const emit = (event: string, data: unknown) => events.push({ id: `event_${String(events.length + 1).padStart(4, '0')}`, event, data: structuredClone(data) });

  /** A change made at WorkOS (dashboard, widget, accepted invitation) with its event. */
  const setMembership = (user_id: string, organization_id: string, status: Status, role = 'member') => {
    const existing = memberships.find(m => m.user_id === user_id && m.organization_id === organization_id);
    const membership = existing ?? { user_id, organization_id, status, role: { slug: role } };
    Object.assign(membership, { status, role: { slug: role } });
    if (!existing) memberships.push(membership);
    emit(existing ? 'organization_membership.updated' : 'organization_membership.created', membership);
  };
  const deleteMembership = (user_id: string, organization_id: string) => {
    const index = memberships.findIndex(m => m.user_id === user_id && m.organization_id === organization_id);
    emit('organization_membership.deleted', memberships.splice(index, 1)[0]);
  };

  type Body = Record<'name' | 'external_id' | 'user_id' | 'organization_id' | 'role_slug', string> & { scopes?: ReadonlyArray<string> };
  /** Handlers by `METHOD /path`; the external-id lookup is keyed by its prefix. */
  const routes: Record<string, (query: URLSearchParams, body: Body, path: string) => Response> = {
    'GET /organizations/external_id': (_query, _body, path) => {
      const found = organizations.find(org => org.external_id === decodeURIComponent(path.split('/').pop()!));
      return found ? Response.json(found) : Response.json({ message: 'Not found' }, { status: 404 });
    },
    'POST /organizations': (_query, body) => {
      if (organizations.some(org => org.external_id === body.external_id)) return Response.json({ message: 'external_id taken' }, { status: 409 });
      const organization = { id: `org_${organizations.length + 1}`, name: body.name, external_id: body.external_id };
      organizations.push(organization);
      return Response.json(organization, { status: 201 });
    },
    'POST /user_management/organization_memberships': (_query, body) => {
      setMembership(body.user_id, body.organization_id, 'active', body.role_slug);
      return Response.json(memberships.find(m => m.user_id === body.user_id && m.organization_id === body.organization_id), { status: 201 });
    },
    'GET /user_management/organization_memberships': query => {
      const statuses = query.get('statuses')?.split(',') ?? ['active'];
      return Response.json({ data: memberships.filter(m => m.user_id === query.get('user_id') && statuses.includes(m.status)), list_metadata: { after: null } });
    },
    'GET /events': query => {
      const types = query.get('events')!.split(',');
      const start = query.has('after') ? events.findIndex(event => event.id === query.get('after')) + 1 : 0;
      const page = events.slice(start).filter(event => types.includes(event.event)).slice(0, Number(query.get('limit')));
      return Response.json({ object: 'list', data: page.map(event => ({ object: 'event', ...event, created_at: '2026-10-09T00:00:00.000Z' })), list_metadata: { after: page.at(-1)?.id ?? null } });
    },
    // Only the user-management scope is ever requested; the fake token names who it is for.
    'POST /widgets/token': (_query, body) =>
      body.scopes?.join() === 'widgets:users-table:manage'
        ? Response.json({ token: `widget:${body.user_id}:${body.organization_id}` })
        : Response.json({ message: 'unexpected scopes' }, { status: 422 }),
  };

  /** The client always sends a method, the bearer key and (for POST) a JSON body. */
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const key = `${init.method} ${url.pathname}`;
    requests.push(`${key}${url.search}`);
    const authorized = url.origin === 'https://api.workos.com' && new Headers(init.headers).get('authorization') === `Bearer ${API_KEY}`;
    if (!authorized) return Response.json({}, { status: 401 });
    if (failOnce.delete(key)) return Response.json({ message: 'fixture outage' }, { status: 500 });
    const route = routes[key.replace(/^(GET \/organizations\/external_id)\/.*/, '$1')] ?? (() => Response.json({ message: 'unexpected request' }, { status: 400 }));
    return route(url.searchParams, JSON.parse(String(init.body ?? '{}')), url.pathname);
  }) as typeof globalThis.fetch;

  /** `WorkosOrganizations` over this fake, under `issuer`. */
  const layer = (issuer: string, selfServe: boolean) =>
    Layer.succeed(WorkosOrganizations, Option.some(workosSettings({ apiKey: Redacted.make(API_KEY), timeoutMs: 5_000, fetch, issuer, selfServe })));

  return { organizations, memberships, events, requests, failOnce, emit, setMembership, deleteMembership, layer };
};

/** The real API with the kernel authenticator, plus SQL on the same disposable database. */
const withServer = (client: Option.Option<SignIn>, organizations?: Layer.Layer<WorkosOrganizations>) =>
  serveApiWithDb({ overrides: { signIn: Layer.succeed(SignInSettings, { client, embeddedIssuer: null }), ...(organizations ? { organizations } : {}) } });

/** Soft-deletes a workspace as `deleteWorkspace` does; a negative `days` puts the purge time in the past. */
const markDeleted = (db: Layer.Layer<SqlClient.SqlClient, unknown>) => (id: string, days: number) =>
  Effect.provide(Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE workspaces SET deleted_at = UTC_TIMESTAMP(6), purge_after = UTC_TIMESTAMP(6) + INTERVAL ${days} DAY WHERE id = ${id}`), db);

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

  it.scoped('replaces a seeded placeholder with the issuer name and email, and keeps them when a later token omits the claims', () =>
    Effect.gen(function* () {
      const { issuer, client } = configured();
      const { base, db } = yield* withServer(client);
      const [owner] = yield* Effect.provide(seedWorkspace('Acme', ['owner']), db);
      const subject = yield* Effect.provide(identify(owner!), db);
      const sessionOf = (response: Response) => get(`${base}/api/v1/session`, `sanctum_session=${cookieValue(response, 'sanctum_session')}`).then(r => r.json() as Promise<AccessScope>);

      const first = yield* Effect.promise(() => signIn(base, issuer, { sub: subject, name: '  Ada Lovelace ', email: 'ada@example.test' }));
      expect((yield* Effect.promise(() => sessionOf(first))).principal).toEqual({ id: owner!.principal.id, kind: 'human', display_name: 'Ada Lovelace', email: 'ada@example.test' });

      const later = yield* Effect.promise(() => signIn(base, issuer, { sub: subject }));
      expect((yield* Effect.promise(() => sessionOf(later))).principal).toMatchObject({ display_name: 'Ada Lovelace', email: 'ada@example.test' });
    }),
  );

  it.scoped('with an email and no name, the email replaces the seeded placeholder; given and family name beat it', () =>
    Effect.gen(function* () {
      const { issuer, client } = configured();
      const { base, db } = yield* withServer(client);
      const [owner] = yield* Effect.provide(seedWorkspace('Acme', ['owner']), db);
      const subject = yield* Effect.provide(identify(owner!), db);
      const principalOf = (response: Response) => get(`${base}/api/v1/session`, `sanctum_session=${cookieValue(response, 'sanctum_session')}`).then(r => r.json() as Promise<AccessScope>).then(a => a.principal);

      const emailOnly = yield* Effect.promise(() => signIn(base, issuer, { sub: subject, email: 'cap@example.test' }).then(principalOf));
      expect(emailOnly).toMatchObject({ display_name: 'cap@example.test', email: 'cap@example.test' });

      const parts = yield* Effect.promise(() => signIn(base, issuer, { sub: subject, email: 'cap@example.test', given_name: 'Cap', family_name: 'Tain' }).then(principalOf));
      expect(parts).toMatchObject({ display_name: 'Cap Tain', email: 'cap@example.test' });
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

      // A deleted workspace drops out of the choice: the live one is entered, and an owner alone may still enter a deleted one until its purge.
      const enteredWorkspace = (grant: Grant) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() => signIn(base, issuer, grant));
          if (cookieValue(response, 'sanctum_session') === undefined) return null;
          const [row] = yield* Effect.provide(
            Effect.flatMap(SqlClient.SqlClient, sql => sql<{ workspace_id: string }>`SELECT workspace_id FROM browser_sessions WHERE principal_id = ${first!.principal.id} ORDER BY created_at DESC LIMIT 1`),
            db,
          );
          return row!.workspace_id;
        });
      const mark = markDeleted(db);
      yield* mark(second!.workspace_id, 7);
      expect(yield* enteredWorkspace({ sub })).toBe(first!.workspace_id);
      yield* mark(first!.workspace_id, 7);
      expect(yield* enteredWorkspace({ sub })).toBe(second!.workspace_id);
      yield* mark(second!.workspace_id, -1);
      expect(yield* enteredWorkspace({ sub })).toBeNull();
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

  it.scoped('bootstraps a new owner after the only workspace was deleted, and refuses to add an owner to the deleted one', () =>
    Effect.gen(function* () {
      const { client } = configured();
      const { db } = yield* withServer(client);
      const owner = (subject: string, workspace: OwnerInput['workspace']) =>
        Effect.provide(createOwner({ issuer: ISSUER, subject, display_name: 'Owner', workspace }), db);
      const mark = markDeleted(db);

      const first = yield* owner('user_first', { name: 'Acme', timezone: 'UTC' });
      yield* mark(first.workspace_id, 7);
      const refused = yield* Effect.flip(owner('user_cofounder', { id: first.workspace_id }));
      expect(refused).toMatchObject({ _tag: 'OwnerRefused', message: expect.stringContaining('was deleted at') });
      const second = yield* owner('user_first', { name: 'Again', timezone: 'UTC' });
      expect(second.workspace_id).not.toBe(first.workspace_id);
      expect(second.principal_id).toBe(first.principal_id);
      expect(yield* Effect.flip(owner('user_other', { name: 'Third', timezone: 'UTC' }))).toMatchObject({ _tag: 'OwnerRefused' });

      const purge = (workspace_id: WorkspaceId) =>
        Effect.gen(function* () {
          yield* mark(workspace_id, -1);
          yield* enqueueJob({ workspace_id, kind: 'workspace.purge', work_key: 'purge', payload: { deleted_by: first.principal_id }, requested_by: null });
          const lease = Option.getOrThrow(yield* claimJob(['workspace.purge'], 60_000));
          yield* Effect.provide(purgeWorkspace(lease.job), memoryObjectStore().layer);
        }).pipe(Effect.provide(db));
      yield* mark(second.workspace_id, 7);
      yield* purge(first.workspace_id);
      yield* purge(second.workspace_id);
      const third = yield* owner('user_first', { name: 'Third', timezone: 'UTC' });
      expect(third.workspace_id).not.toBe(second.workspace_id);
      expect(third.principal_id).not.toBe(first.principal_id);
      const [row] = yield* Effect.provide(
        Effect.flatMap(SqlClient.SqlClient, sql => sql<{ n: number }>`SELECT COUNT(*) AS n FROM principal_identities WHERE subject = 'user_first'`),
        db,
      );
      expect(Number(row!.n)).toBe(1);
    }),
  );

  it.scoped('reports sign-in as unavailable while no issuer is configured', () =>
    Effect.gen(function* () {
      const { base } = yield* withServer(Option.none());
      expect(yield* Effect.promise(() => fetch(`${base}/auth/config`).then(r => r.json()))).toEqual({ sign_in: false, embedded_issuer: null, self_serve_workspaces: false, workos_organizations: false });
      const login = yield* Effect.promise(() => get(`${base}/auth/login`));
      expect(login.status).toBe(503);
      expect(yield* Effect.promise(() => login.json())).toMatchObject({ code: 'unavailable', retryable: false });
      expect((yield* Effect.promise(() => get(`${base}/auth/callback?code=x&state=y`))).headers.get('location')).toBe('/?signin=unconfigured');
    }),
  );
});

describe('WorkOS organizations at sign-in', () => {
  const sessionOf = (base: string, response: Response) => get(`${base}/api/v1/session`, `sanctum_session=${cookieValue(response, 'sanctum_session')}`);
  const workosWrites = (requests: ReadonlyArray<string>) => requests.filter(request => !request.startsWith('GET '));

  it.scoped('makes a WorkOS member of a linked organization a member, follows its role and leaves unlinked workspaces alone', () =>
    Effect.gen(function* () {
      const { issuer, client } = configured();
      const workos = fakeWorkos();
      const { base, db } = yield* withServer(client, workos.layer(ISSUER, false));
      const [acme] = yield* Effect.provide(seedWorkspace('Acme', ['owner']), db);
      const [unlinked] = yield* Effect.provide(seedWorkspace('Unlinked', ['owner']), db);
      yield* Effect.provide(linkWorkspaceOrg({ workspace_id: acme!.workspace_id, issuer: ISSUER, org_id: 'org_acme' }), db);
      workos.setMembership('user_grace', 'org_acme', 'active', 'member');
      workos.setMembership('user_grace', 'org_elsewhere', 'active', 'owner');

      const first = yield* Effect.promise(() => signIn(base, issuer, { sub: 'user_grace', name: 'Grace Hopper' }));
      expect(first.headers.get('location')).toBe('/');
      expect(yield* Effect.promise(() => sessionOf(base, first).then(r => r.json()))).toMatchObject({
        workspace_id: acme!.workspace_id,
        role: 'member',
        principal: { kind: 'human', display_name: 'Grace Hopper' },
      });

      // A role change at WorkOS applies at the next sign-in; a custom role is a plain member.
      workos.setMembership('user_grace', 'org_acme', 'active', 'admin');
      const promoted = yield* Effect.promise(() => signIn(base, issuer, { sub: 'user_grace' }));
      expect(yield* Effect.promise(() => sessionOf(base, promoted).then(r => r.json()))).toMatchObject({ role: 'admin' });
      workos.setMembership('user_grace', 'org_acme', 'active', 'billing');
      const custom = yield* Effect.promise(() => signIn(base, issuer, { sub: 'user_grace' }));
      expect(yield* Effect.promise(() => sessionOf(base, custom).then(r => r.json()))).toMatchObject({ role: 'member' });

      // Deactivated at WorkOS: the membership ends, and so do the sessions it opened.
      workos.setMembership('user_grace', 'org_acme', 'inactive', 'member');
      expect((yield* Effect.promise(() => signIn(base, issuer, { sub: 'user_grace' }))).headers.get('location')).toMatch(/^\/\?signin=not_member&/);
      expect((yield* Effect.promise(() => sessionOf(base, first))).status).toBe(401);

      // The owner of an unlinked workspace has no WorkOS membership and keeps theirs.
      const owner = yield* Effect.provide(identify(unlinked!), db);
      const kept = yield* Effect.promise(() => signIn(base, issuer, { sub: owner }));
      expect(yield* Effect.promise(() => sessionOf(base, kept).then(r => r.json()))).toMatchObject({ workspace_id: unlinked!.workspace_id, role: 'owner' });
      expect(workosWrites(workos.requests)).toEqual([]);
    }),
  );

  it.scoped('self-serve off leaves not_member; on, it creates the organization, workspace and owner once even across a retry', () =>
    Effect.gen(function* () {
      const { issuer, client } = configured();
      const create = `/auth/login?${new URLSearchParams({ workspace_name: ' Acme Research ', timezone: 'Europe/Berlin' })}`;

      const off = fakeWorkos();
      const closed = yield* withServer(client, off.layer(ISSUER, false));
      expect((yield* Effect.promise(() => get(`${closed.base}${create}`))).status).toBe(403);
      expect((yield* Effect.promise(() => signIn(closed.base, issuer, { sub: 'user_ada' }))).headers.get('location')).toMatch(/^\/\?signin=not_member&/);
      expect(workosWrites(off.requests)).toEqual([]);

      const workos = fakeWorkos();
      const { base, db } = yield* withServer(client, workos.layer(ISSUER, true));
      expect(yield* Effect.promise(() => fetch(`${base}/auth/config`).then(r => r.json()))).toMatchObject({ sign_in: true, self_serve_workspaces: true });
      expect((yield* Effect.promise(() => get(`${base}/auth/login?workspace_name=Acme&timezone=Mars%2FOlympus`))).status).toBe(400);
      const counts = Effect.flatMap(SqlClient.SqlClient, sql =>
        sql<{ w: number; o: number; p: number; m: number; j: number }>`SELECT (SELECT COUNT(*) FROM workspaces) AS w, (SELECT COUNT(*) FROM workspace_orgs) AS o,
          (SELECT COUNT(*) FROM principals) AS p, (SELECT COUNT(*) FROM workspace_members) AS m, (SELECT COUNT(*) FROM jobs WHERE kind = 'workos.sync') AS j`,
      ).pipe(Effect.map(([row]) => [row!.w, row!.o, row!.p, row!.m, row!.j].map(Number)));

      // WorkOS fails after creating the organization: the sign-in fails and Sanctum creates nothing.
      workos.failOnce.add('POST /user_management/organization_memberships');
      expect((yield* Effect.promise(() => signIn(base, issuer, { sub: 'user_ada', name: 'Ada' }, create))).headers.get('location')).toBe('/?signin=failed');
      expect(workos.organizations).toHaveLength(1);
      expect(yield* Effect.provide(counts, db)).toEqual([0, 0, 0, 0, 0]);

      // The retry reuses that organization and finishes every step once.
      const created = yield* Effect.promise(() => signIn(base, issuer, { sub: 'user_ada', name: 'Ada' }, create));
      expect(created.headers.get('location')).toBe('/');
      const access = yield* Effect.promise(() => sessionOf(base, created).then(r => r.json() as Promise<AccessScope>));
      expect(access).toMatchObject({ role: 'owner', principal: { display_name: 'Ada' } });
      expect(workos.organizations).toEqual([{ id: 'org_1', name: 'Acme Research', external_id: 'sanctum-self-serve:user_ada' }]);
      expect(workos.memberships).toEqual([{ user_id: 'user_ada', organization_id: 'org_1', status: 'active', role: { slug: 'owner' } }]);
      const [workspace] = yield* Effect.provide(
        Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT w.name, w.timezone, w.seat_limit, o.org_id FROM workspaces w JOIN workspace_orgs o ON o.workspace_id = w.id WHERE w.id = ${access.workspace_id}`),
        db,
      );
      // A null seat limit is the hosted default (`SANCTUM_DEFAULT_SEAT_LIMIT`).
      expect(workspace).toEqual({ name: 'Acme Research', timezone: 'Europe/Berlin', seat_limit: null, org_id: 'org_1' });
      expect(yield* Effect.provide(counts, db)).toEqual([1, 1, 1, 1, 1]);

      // Asking again once a member: an ordinary sign-in to the same workspace, nothing new.
      const again = yield* Effect.promise(() => signIn(base, issuer, { sub: 'user_ada' }, create));
      expect(yield* Effect.promise(() => sessionOf(base, again).then(r => r.json()))).toMatchObject({ workspace_id: access.workspace_id, role: 'owner' });
      expect(yield* Effect.provide(counts, db)).toEqual([1, 1, 1, 1, 1]);

      // The owner is removed at WorkOS: asking again must not re-add the owner to the linked organization.
      workos.deleteMembership('user_ada', 'org_1');
      const removed = yield* Effect.promise(() => signIn(base, issuer, { sub: 'user_ada' }, create));
      expect(removed.headers.get('location')).toMatch(/^\/\?signin=not_member&/);
      expect(workos.memberships).toEqual([]);
      expect(yield* Effect.provide(counts, db)).toEqual([1, 1, 1, 1, 1]);
      expect(workosWrites(workos.requests)).toEqual(['POST /organizations', 'POST /user_management/organization_memberships', 'POST /user_management/organization_memberships']);
    }),
  );
});

describe('workos.sync events job', () => {
  it.scoped('applies membership events, ends sessions on removal, only detaches deleted organizations and resumes from its cursor', () =>
    Effect.gen(function* () {
      const { base, db } = yield* serveApiWithDb();
      const workos = fakeWorkos();
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const count = (table: string) => Effect.map(sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`, ([row]) => Number(row!.n));
        const [owner, member] = yield* seedWorkspace('Acme', ['owner', 'member']);
        const workspace_id = owner!.workspace_id;
        yield* linkWorkspaceOrg({ workspace_id, issuer: ISSUER, org_id: 'org_acme' });
        yield* linkIdentity({ issuer: ISSUER, subject: 'user_owner', principal_id: owner!.principal.id });
        yield* linkIdentity({ issuer: ISSUER, subject: 'user_member', principal_id: member!.principal.id });
        const opened = yield* openSession({ workspace_id, principal_id: member!.principal.id });
        const sessionStatus = Effect.promise(() => get(`${base}/api/v1/session`, `sanctum_session=${opened.token}`).then(r => r.status));
        const role = (principal_id: string) =>
          Effect.map(sql<{ role: string; active: number }>`SELECT role, revoked_at IS NULL AS active FROM workspace_members WHERE workspace_id = ${workspace_id} AND principal_id = ${principal_id}`, ([row]) =>
            Number(row!.active) === 1 ? row!.role : 'revoked',
          );

        /** One worker pass on the scheduled row with a new WorkOS client, as after a restart: only MySQL carries state between passes. */
        const run = Effect.gen(function* () {
          const [job] = yield* sql<{ id: string; workspace_id: WorkspaceId }>`SELECT id, workspace_id FROM jobs WHERE kind = 'workos.sync' AND status = 'pending'`;
          const claimed = { id: JobId.make(job!.id), workspace_id: job!.workspace_id, kind: 'workos.sync', work_key: 'events', payload: {}, requested_by: null, source_revision: null, attempt: 1, lease_generation: 1 } as const;
          return yield* syncWorkosEvents(claimed).pipe(Effect.provide(workos.layer(ISSUER, true)));
        });

        yield* armWorkosSync.pipe(Effect.provide(workos.layer(ISSUER, true)));
        workos.setMembership('user_member', 'org_acme', 'active', 'admin');
        workos.setMembership('user_stranger', 'org_acme', 'active', 'owner');
        expect(yield* run).toMatchObject({ status: 'succeeded', result: { applied: 2, cursor: 'event_0002' } });
        expect(yield* role(member!.principal.id)).toBe('admin');
        // An identity that never signed in gets no principal until its first sign-in.
        expect(yield* count('principals')).toBe(2);
        // The pass scheduled the next one a minute out.
        const next = yield* sql<{ later: number }>`SELECT available_at > UTC_TIMESTAMP(6) + INTERVAL 30 SECOND AS later FROM jobs WHERE kind = 'workos.sync' AND status = 'pending'`;
        expect(next.map(job => Number(job.later))).toEqual([1]);

        workos.deleteMembership('user_member', 'org_acme');
        expect(yield* run).toMatchObject({ result: { applied: 1, cursor: 'event_0003' } });
        expect(yield* role(member!.principal.id)).toBe('revoked');
        expect(yield* sessionStatus).toBe(401);

        workos.emit('organization.deleted', { id: 'org_acme', object: 'organization', name: 'Acme' });
        expect(yield* run).toMatchObject({ result: { applied: 1, cursor: 'event_0004' } });
        expect(yield* count('workspace_orgs')).toBe(0);
        expect(yield* count('workspaces')).toBe(1);
        expect(yield* role(owner!.principal.id)).toBe('owner');

        // Each pass asked WorkOS only for events after the saved cursor, and no pass wrote to WorkOS.
        expect(workos.requests.every(request => request.startsWith('GET /events?'))).toBe(true);
        expect(workos.requests.map(request => new URLSearchParams(request.split('?')[1]).get('after'))).toEqual([null, 'event_0002', 'event_0003']);
        expect(yield* sql`SELECT \`cursor\` FROM sync_cursors WHERE name = 'workos.events'`).toEqual([{ cursor: 'event_0004' }]);
      }).pipe(Effect.provide(db));
    }),
  );
});

describe('WorkOS widget token', () => {
  it.scoped('issues an admin a token for their WorkOS user and linked organization, and refuses members and missing links clearly', () =>
    Effect.gen(function* () {
      const { client } = configured();
      const workos = fakeWorkos();
      const { base, db } = yield* withServer(client, workos.layer(ISSUER, false));
      expect(yield* Effect.promise(() => fetch(`${base}/auth/config`).then(r => r.json()))).toMatchObject({ workos_organizations: true });
      const [owner, member] = yield* Effect.provide(seedWorkspace('Acme', ['owner', 'member']), db);
      const open = (access: AccessScope) => Effect.provide(openSession({ workspace_id: access.workspace_id, principal_id: access.principal.id }), db);
      const request = (session: { token: string; csrf_token: string }, csrf = session.csrf_token) =>
        Effect.promise(async () => {
          const response = await get(`${base}/api/v1/workspace/widget-token`, `sanctum_session=${session.token}`, { method: 'POST', headers: { 'x-csrf-token': csrf } });
          return { status: response.status, cache: response.headers.get('cache-control'), body: (await response.json()) as { token?: string; message?: string } };
        });
      const ownerSession = yield* open(owner!);

      // A login-link owner without a WorkOS identity, then one whose workspace has no organization: 404 with the reason.
      expect(yield* request(ownerSession)).toMatchObject({ status: 404, body: { message: 'Your account has no WorkOS sign-in yet. Use Connect sign-in first.' } });
      const subject = yield* Effect.provide(identify(owner!), db);
      expect(yield* request(ownerSession)).toMatchObject({ status: 404, body: { message: 'This workspace is not linked to a WorkOS organization.' } });

      yield* Effect.provide(linkWorkspaceOrg({ workspace_id: owner!.workspace_id, issuer: ISSUER, org_id: 'org_acme' }), db);
      expect(yield* request(ownerSession)).toEqual({ status: 200, cache: 'no-store', body: { token: `widget:${subject}:org_acme` } });
      expect(yield* request(ownerSession, 'wrong')).toMatchObject({ status: 403, body: { message: 'CSRF token is missing or invalid' } });

      // A member is refused before WorkOS is asked.
      yield* Effect.provide(identify(member!), db);
      expect(yield* request(yield* open(member!))).toMatchObject({ status: 403, body: { required_scope: 'workspace:admin' } });
      expect(workos.requests).toEqual(['POST /widgets/token']);

      workos.failOnce.add('POST /widgets/token');
      expect(yield* request(ownerSession)).toMatchObject({ status: 503, body: { message: 'WorkOS did not issue a widget token', retryable: true } });
    }),
  );

  it.scoped('answers 503 when the server has no WorkOS organizations', () =>
    Effect.gen(function* () {
      const { base, db } = yield* withServer(configured().client);
      expect(yield* Effect.promise(() => fetch(`${base}/auth/config`).then(r => r.json()))).toMatchObject({ workos_organizations: false });
      const [owner] = yield* Effect.provide(seedWorkspace('Acme', ['owner']), db);
      const session = yield* Effect.provide(openSession({ workspace_id: owner!.workspace_id, principal_id: owner!.principal.id }), db);
      for (const [method, path] of [['POST', 'widget-token'], ['GET', 'team'], ['POST', 'team']]) {
        const response = yield* Effect.promise(() =>
          get(`${base}/api/v1/workspace/${path}`, `sanctum_session=${session.token}`, { method: method!, headers: { 'x-csrf-token': session.csrf_token } }));
        expect(response.status).toBe(503);
      }
    }),
  );
});

describe('WorkOS Set up team', () => {
  it.scoped('links an existing workspace once for its owner, and existing members keep access until WorkOS grants and removes them', () =>
    Effect.gen(function* () {
      const { issuer, client } = configured();
      const workos = fakeWorkos();
      const { base, db } = yield* withServer(client, workos.layer(ISSUER, false));
      const [owner, admin, member] = yield* Effect.provide(seedWorkspace('Acme', ['owner', 'admin', 'member']), db);
      const workspace_id = owner!.workspace_id;
      const open = (access: AccessScope) => Effect.provide(openSession({ workspace_id, principal_id: access.principal.id }), db);
      const team = (session: { token: string; csrf_token: string }, method: 'GET' | 'POST') =>
        Effect.promise(async () => {
          const response = await get(`${base}/api/v1/workspace/team`, `sanctum_session=${session.token}`, { method, headers: { 'x-csrf-token': session.csrf_token } });
          return { status: response.status, body: (await response.json()) as { linked?: boolean; message?: string } };
        });
      /** `role`, `role (WorkOS)` when WorkOS granted it, or `revoked`. */
      const membership = (access: AccessScope) =>
        Effect.provide(
          Effect.flatMap(SqlClient.SqlClient, sql =>
            sql<{ role: string; active: number; org_issuer: string | null }>`SELECT role, revoked_at IS NULL AS active, org_issuer FROM workspace_members
              WHERE workspace_id = ${workspace_id} AND principal_id = ${access.principal.id}`),
          db,
        ).pipe(Effect.map(([row]) => (Number(row!.active) !== 1 ? 'revoked' : row!.org_issuer === ISSUER ? `${row!.role} (WorkOS)` : row!.role)));
      /** One `workos.sync` pass on the scheduled row. */
      const sync = Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [job] = yield* sql<{ id: string; workspace_id: WorkspaceId }>`SELECT id, workspace_id FROM jobs WHERE kind = 'workos.sync' AND status = 'pending'`;
          const claimed = { id: JobId.make(job!.id), workspace_id: job!.workspace_id, kind: 'workos.sync', work_key: 'events', payload: {}, requested_by: null, source_revision: null, attempt: 1, lease_generation: 1 } as const;
          return yield* syncWorkosEvents(claimed).pipe(Effect.provide(workos.layer(ISSUER, false)));
        }),
        db,
      );
      const ownerSession = yield* open(owner!);
      expect(yield* team(ownerSession, 'GET')).toEqual({ status: 200, body: { linked: false } });

      // A login-link owner first connects WorkOS sign-in; admins and members are refused before WorkOS is asked.
      expect(yield* team(ownerSession, 'POST')).toMatchObject({ status: 404, body: { message: 'Your account has no WorkOS sign-in yet. Use Connect sign-in first.' } });
      yield* Effect.provide(identify(admin!), db);
      expect(yield* team(yield* open(admin!), 'POST')).toMatchObject({ status: 403, body: { message: 'Only the workspace owner can set up the team' } });
      expect(yield* team(yield* open(member!), 'POST')).toMatchObject({ status: 403, body: { required_scope: 'workspace:admin' } });
      const memberSubject = yield* Effect.provide(identify(member!), db);
      const ownerSubject = yield* Effect.provide(identify(owner!), db);
      expect(workos.requests).toEqual([]);

      // WorkOS fails after creating the organization; the retry reuses it, and a repeat creates nothing.
      workos.failOnce.add('POST /user_management/organization_memberships');
      expect(yield* team(ownerSession, 'POST')).toMatchObject({ status: 503, body: { message: 'WorkOS did not set up the team. Try again.' } });
      expect(yield* team(ownerSession, 'POST')).toEqual({ status: 200, body: { linked: true } });
      expect(yield* team(ownerSession, 'POST')).toEqual({ status: 200, body: { linked: true } });
      expect(yield* team(ownerSession, 'GET')).toEqual({ status: 200, body: { linked: true } });
      expect(workos.organizations).toEqual([{ id: 'org_1', name: 'Acme', external_id: `sanctum-workspace:${workspace_id}` }]);
      expect(workos.memberships).toEqual([{ user_id: ownerSubject, organization_id: 'org_1', status: 'active', role: { slug: 'owner' } }]);
      expect(workos.requests.filter(request => !request.startsWith('GET '))).toEqual(['POST /organizations', 'POST /user_management/organization_memberships', 'POST /user_management/organization_memberships']);
      expect(yield* Effect.provide(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT org_id FROM workspace_orgs WHERE workspace_id = ${workspace_id}`), db)).toEqual([{ org_id: 'org_1' }]);
      // The widgets now load for the owner.
      const token = yield* Effect.promise(() =>
        get(`${base}/api/v1/workspace/widget-token`, `sanctum_session=${ownerSession.token}`, { method: 'POST', headers: { 'x-csrf-token': ownerSession.csrf_token } }).then(r => r.json()));
      expect(token).toEqual({ token: `widget:${ownerSubject}:org_1` });

      // Only the owner moved to WorkOS; the others keep their Sanctum memberships after a sync pass and the member's own AuthKit sign-in.
      expect([yield* membership(owner!), yield* membership(admin!), yield* membership(member!)]).toEqual(['owner (WorkOS)', 'admin', 'member']);
      expect(yield* sync).toMatchObject({ status: 'succeeded' });
      const signedIn = yield* Effect.promise(() => signIn(base, issuer, { sub: memberSubject }));
      expect(signedIn.headers.get('location')).toBe('/');
      expect([yield* membership(admin!), yield* membership(member!)]).toEqual(['admin', 'member']);

      // Accepting the invitation makes the membership WorkOS's, so a removal there now revokes it.
      workos.setMembership(memberSubject, 'org_1', 'active', 'member');
      yield* Effect.promise(() => signIn(base, issuer, { sub: memberSubject }));
      expect(yield* membership(member!)).toBe('member (WorkOS)');
      workos.deleteMembership(memberSubject, 'org_1');
      expect(yield* sync).toMatchObject({ status: 'succeeded' });
      expect([yield* membership(owner!), yield* membership(admin!), yield* membership(member!)]).toEqual(['owner (WorkOS)', 'admin', 'revoked']);
    }),
  );
});
