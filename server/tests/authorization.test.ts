import { randomUUID } from 'node:crypto';
import { HttpServer } from '@effect/platform';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, Authenticated, type MeetingId, type WorkspaceId } from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { ConfigProvider, Context, Effect, Layer, Option } from 'effect';
import { createAgent } from '../src/agents.ts';
import { authorizeMeeting, identityPrincipal, listVisibleMeetingIds, openSession, resolveAccess } from '../src/auth.ts';
import { scopedCacheKey } from '../src/cache.ts';
import { dbLayer } from '../src/db.ts';
import { serverLayer } from '../src/main.ts';
import { loadMigrations, migrate } from '../src/migrate.ts';
import { grantMeetingAccess } from '../src/store.ts';
import { createTestDatabase, withDatabase } from './support/database.ts';
import { fixtureAccess, seedWorkspace } from './support/fixtures.ts';
import { upgradeStatus } from './support/media.ts';

/** Real HTTP server with the kernel authenticator plus direct SQL on the same disposable database. */
const withServer = <A, E>(use: (base: string) => Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
    yield* Effect.provide(migrate(loadMigrations()), dbLayer(database.mysql));
    const context = yield* Layer.build(serverLayer({ apiPort: 0, mysql: database.mysql }));
    const address = Context.get(context, HttpServer.HttpServer).address;
    if (address._tag !== 'TcpAddress') throw new Error('expected TCP');
    return yield* Effect.provide(use(`http://127.0.0.1:${address.port}`), dbLayer(database.mysql));
  });

const call = (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  Effect.promise(async () => {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  });

const sessionHeaders = (member: { workspace_id: WorkspaceId; principal: { id: AccessScope['principal']['id'] } }) =>
  Effect.map(openSession({ workspace_id: member.workspace_id, principal_id: member.principal.id }), session => ({
    cookie: `sanctum_session=${session.token}`,
    'x-csrf-token': session.csrf_token,
  }));

const meeting = (workspace_id: WorkspaceId, visibility: 'restricted' | 'workspace') =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = randomUUID() as MeetingId;
    yield* sql`INSERT INTO meetings (id, workspace_id, state, timezone, started_at, visibility, processing, created_at, updated_at)
      VALUES (${id}, ${workspace_id}, 'active', 'UTC', UTC_TIMESTAMP(6), ${visibility}, '{}', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    return id;
  });

const tagOf = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) => Effect.map(Effect.flip(effect), error => error._tag);

const researcher = { display_name: 'Researcher', scopes: ['context:read'], meetings: { kind: 'accessible' }, expires_at: null } as const;

describe('authorization boundary', () => {
  it.scoped('keeps sessions, agent credentials and revocation inside one workspace', () =>
    withServer(base =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [ownerA, memberA] = yield* seedWorkspace('Acme', ['owner', 'member']);
        const [ownerB] = yield* seedWorkspace('Acme', ['owner']);
        const a = yield* sessionHeaders(ownerA!);
        const b = yield* sessionHeaders(ownerB!);
        const member = yield* sessionHeaders(memberA!);

        const session = yield* call(`${base}/api/v1/session`, { headers: { cookie: a.cookie } });
        expect(session.body).toMatchObject({ workspace_id: ownerA!.workspace_id, role: 'owner', meetings: { kind: 'accessible' } });
        expect(session.body.scopes).toContain('workspace:admin');

        const noCsrf = yield* call(`${base}/api/v1/agents`, { method: 'POST', headers: { cookie: a.cookie }, body: researcher });
        expect(noCsrf).toMatchObject({ status: 403, body: { code: 'forbidden' } });
        const created = yield* call(`${base}/api/v1/agents`, { method: 'POST', headers: a, body: researcher });
        expect(created.status).toBe(201);
        const { agent, credential, token } = created.body;
        expect(credential).toMatchObject({ scopes: ['context:read'], revoked_at: null });
        const [stored] = yield* sql<{ matches: number }>`SELECT COUNT(*) AS matches FROM agent_credentials WHERE token_hash = ${token}`;
        expect(Number(stored!.matches)).toBe(0);

        const bearer = { authorization: `Bearer ${token}` };
        const asAgent = yield* call(`${base}/api/v1/session`, { headers: bearer });
        expect(asAgent.body).toMatchObject({ workspace_id: ownerA!.workspace_id, role: 'agent', scopes: ['context:read'] });

        expect((yield* call(`${base}/api/v1/agents`, { method: 'POST', headers: member, body: researcher })).status).toBe(403);
        expect((yield* call(`${base}/api/v1/agents`, { headers: b })).body).toEqual({ items: [], next_cursor: null });
        const revokePath = `${base}/api/v1/agents/${agent.id}/credentials/${credential.id}`;
        expect((yield* call(revokePath, { method: 'DELETE', headers: b })).status).toBe(404);
        expect((yield* call(revokePath, { method: 'DELETE', headers: member })).status).toBe(404);
        expect((yield* call(`${base}/api/v1/session`, { headers: bearer })).status).toBe(200);

        const before = yield* resolveAccess({ workspace_id: ownerA!.workspace_id, principal_id: ownerA!.principal.id });
        expect((yield* call(revokePath, { method: 'DELETE', headers: a })).status).toBe(204);
        expect((yield* call(revokePath, { method: 'DELETE', headers: a })).status).toBe(204);
        expect((yield* call(`${base}/api/v1/session`, { headers: bearer })).status).toBe(401);
        const after = yield* resolveAccess({ workspace_id: ownerA!.workspace_id, principal_id: ownerA!.principal.id });
        expect(after.permission_revision).toBeGreaterThan(before.permission_revision);
        expect(yield* tagOf(resolveAccess({ workspace_id: ownerA!.workspace_id, principal_id: agent.id }))).toBe('Forbidden');
        const listed = yield* call(`${base}/api/v1/agents`, { headers: a });
        expect(listed.body.items).toHaveLength(1);
        expect(listed.body.items[0].credential.revoked_at).not.toBeNull();
      }),
    ),
  );

  it.scoped('pages credentials with an opaque keyset cursor', () =>
    withServer(base =>
      Effect.gen(function* () {
        const [owner] = yield* seedWorkspace('Acme', ['owner']);
        const headers = yield* sessionHeaders(owner!);
        for (let index = 0; index < 3; index++) {
          yield* call(`${base}/api/v1/agents`, { method: 'POST', headers, body: { ...researcher, display_name: `Agent ${index}` } });
        }
        const first = yield* call(`${base}/api/v1/agents?limit=2`, { headers });
        const second = yield* call(`${base}/api/v1/agents?limit=2&cursor=${first.body.next_cursor}`, { headers });
        expect(first.body.items).toHaveLength(2);
        expect(second.body).toMatchObject({ next_cursor: null });
        const ids = [...first.body.items, ...second.body.items].map((item: { credential: { id: string } }) => item.credential.id);
        expect(new Set(ids).size).toBe(3);
        expect((yield* call(`${base}/api/v1/agents?limit=0`, { headers })).status).toBe(400);
      }),
    ),
  );

  it.effect('rejects expired credentials, expired sessions, revoked memberships and non-member sessions', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [owner, member, device] = yield* seedWorkspace('Acme', ['owner', 'member', 'device']);
        const admin = yield* resolveAccess({ workspace_id: owner!.workspace_id, principal_id: owner!.principal.id });
        const expired = yield* createAgent(admin, { ...researcher, expires_at: '2020-01-01T00:00:00Z' as never });
        expect(yield* tagOf(resolveAccess({ workspace_id: owner!.workspace_id, principal_id: expired.agent.id }))).toBe('Forbidden');

        const deviceAccess = yield* resolveAccess({ workspace_id: device!.workspace_id, principal_id: device!.principal.id });
        expect(deviceAccess.scopes).toEqual(['capture:ingest']);
        expect(yield* tagOf(openSession({ workspace_id: owner!.workspace_id, principal_id: expired.agent.id }))).toBe('Forbidden');

        yield* openSession({ workspace_id: member!.workspace_id, principal_id: member!.principal.id });
        yield* sql`UPDATE workspace_members SET revoked_at = UTC_TIMESTAMP(6) WHERE principal_id = ${member!.principal.id}`;
        expect(yield* tagOf(resolveAccess({ workspace_id: member!.workspace_id, principal_id: member!.principal.id }))).toBe('Forbidden');
        expect(yield* tagOf(openSession({ workspace_id: member!.workspace_id, principal_id: member!.principal.id }))).toBe('Forbidden');
        const [other] = yield* seedWorkspace('Other');
        expect(yield* tagOf(openSession({ workspace_id: other!.workspace_id, principal_id: owner!.principal.id }))).toBe('Forbidden');
        yield* sql`UPDATE principals SET disabled_at = UTC_TIMESTAMP(6) WHERE id = ${owner!.principal.id}`;
        expect(yield* tagOf(resolveAccess({ workspace_id: owner!.workspace_id, principal_id: owner!.principal.id }))).toBe('Forbidden');
      }),
      { migrated: true },
    ),
  );

  it.scoped('invalidates revoked and expired sessions over HTTP', () =>
    withServer(base =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [owner, member] = yield* seedWorkspace('Acme', ['owner', 'member']);
        const ownerHeaders = yield* sessionHeaders(owner!);
        const memberHeaders = yield* sessionHeaders(member!);
        expect((yield* call(`${base}/api/v1/session`, { headers: memberHeaders })).status).toBe(200);
        yield* sql`UPDATE workspace_members SET revoked_at = UTC_TIMESTAMP(6) WHERE principal_id = ${member!.principal.id}`;
        expect((yield* call(`${base}/api/v1/session`, { headers: memberHeaders })).status).toBe(401);
        yield* sql`UPDATE browser_sessions SET expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE principal_id = ${owner!.principal.id}`;
        expect((yield* call(`${base}/api/v1/session`, { headers: ownerHeaders })).status).toBe(401);
        expect((yield* call(`${base}/api/v1/session`, { headers: { cookie: 'sanctum_session=forged' } })).status).toBe(401);
        expect((yield* call(`${base}/api/v1/session`)).status).toBe(401);
      }),
    ),
  );

  it.effect('never lets an agent receive scopes or meetings its creator lacks', () =>
    withDatabase(
      Effect.gen(function* () {
        const [owner] = yield* seedWorkspace('Acme', ['owner']);
        const [foreign] = yield* seedWorkspace('Acme', ['owner']);
        const admin = yield* resolveAccess({ workspace_id: owner!.workspace_id, principal_id: owner!.principal.id });
        const restricted = yield* meeting(owner!.workspace_id, 'restricted');
        const elsewhere = yield* meeting(foreign!.workspace_id, 'workspace');
        const limitedAdmin = yield* createAgent(admin, { ...researcher, scopes: ['workspace:admin', 'context:read'] });
        const limited = yield* resolveAccess({ workspace_id: owner!.workspace_id, principal_id: limitedAdmin.agent.id });
        expect(yield* tagOf(createAgent(limited, { ...researcher, scopes: ['recordings:read'] }))).toBe('Forbidden');
        const allowlist = (meeting_ids: ReadonlyArray<MeetingId>) => ({ ...researcher, meetings: { kind: 'allowlist' as const, meeting_ids } });
        expect(yield* tagOf(createAgent(admin, allowlist([elsewhere])))).toBe('NotFound');
        expect(yield* tagOf(createAgent(admin, allowlist([restricted])))).toBe('NotFound');
        yield* grantMeetingAccess({ workspace_id: owner!.workspace_id, meeting_id: restricted, principal_id: owner!.principal.id, access: 'owner', granted_by: owner!.principal.id });
        const scoped = yield* createAgent(admin, allowlist([restricted]));
        expect(scoped.credential.meetings).toEqual({ kind: 'allowlist', meeting_ids: [restricted] });
        const readable = yield* meeting(owner!.workspace_id, 'restricted');
        yield* grantMeetingAccess({ workspace_id: owner!.workspace_id, meeting_id: readable, principal_id: owner!.principal.id, access: 'read', granted_by: owner!.principal.id });
        yield* createAgent(admin, allowlist([readable]));
        for (const scope of ['context:write', 'actions:request'] as const) {
          expect(yield* tagOf(createAgent(admin, { ...allowlist([readable]), scopes: [scope] }))).toBe('NotFound');
        }
        const narrowAdmin = yield* createAgent(admin, { ...allowlist([restricted]), scopes: ['workspace:admin', 'context:read'] });
        const narrow = yield* resolveAccess({ workspace_id: owner!.workspace_id, principal_id: narrowAdmin.agent.id });
        expect(yield* tagOf(createAgent(narrow, researcher))).toBe('Forbidden');
        expect((yield* createAgent(narrow, allowlist([restricted]))).credential.meetings).toEqual({ kind: 'allowlist', meeting_ids: [restricted] });
      }),
      { migrated: true },
    ),
  );

  it.effect('authorizes meetings by explicit grants, workspace visibility and allowlists', () =>
    withDatabase(
      Effect.gen(function* () {
        const [owner, member] = yield* seedWorkspace('Acme', ['owner', 'member']);
        const [foreign] = yield* seedWorkspace('Acme', ['owner']);
        const workspace_id = owner!.workspace_id;
        const granted = yield* meeting(workspace_id, 'restricted');
        const shared = yield* meeting(workspace_id, 'workspace');
        const hidden = yield* meeting(workspace_id, 'restricted');
        const elsewhere = yield* meeting(foreign!.workspace_id, 'workspace');
        yield* grantMeetingAccess({ workspace_id, meeting_id: granted, principal_id: member!.principal.id, access: 'read', granted_by: owner!.principal.id });
        const access = yield* resolveAccess({ workspace_id, principal_id: member!.principal.id });
        const outcome = (meeting_id: MeetingId, need: 'read' | 'write', as: AccessScope = access) =>
          Effect.match(authorizeMeeting(as, meeting_id, need), { onFailure: error => error._tag, onSuccess: () => 'ok' });

        expect(yield* outcome(granted, 'read')).toBe('ok');
        expect(yield* outcome(granted, 'write')).toBe('NotFound');
        expect(yield* outcome(shared, 'write')).toBe('ok');
        expect(yield* outcome(hidden, 'read')).toBe('NotFound');
        expect(yield* outcome(elsewhere, 'read')).toBe('NotFound');
        expect(yield* listVisibleMeetingIds(access)).toEqual([granted, shared].sort());

        const allowlisted = { ...access, meetings: { kind: 'allowlist' as const, meeting_ids: [hidden, elsewhere] } };
        expect(yield* outcome(hidden, 'write', allowlisted)).toBe('ok');
        expect(yield* outcome(shared, 'read', allowlisted)).toBe('NotFound');
        expect(yield* outcome(elsewhere, 'read', allowlisted)).toBe('NotFound');
        expect(yield* listVisibleMeetingIds(allowlisted)).toEqual([hidden]);
        expect(yield* listVisibleMeetingIds({ ...access, meetings: { kind: 'allowlist', meeting_ids: [] } })).toEqual([]);
      }),
      { migrated: true },
    ),
  );

  it.scoped('accepts WebSocket upgrades with a session from its own host, allowed origins or non-browser clients', () =>
    withServer(base =>
      Effect.gen(function* () {
        const [device] = yield* seedWorkspace('Room', ['device']);
        const headers = yield* sessionHeaders(device!);
        const listener = yield* call(`${base}/api/v1/listeners`, { method: 'POST', headers, body: { name: 'Room', mode: 'room', capabilities: {} } });
        expect(listener.status).toBe(201);
        const upgrade = (extra: Record<string, string>) => upgradeStatus(new URL(base).host, `/api/v1/listeners/${listener.body.id}/stream`, extra);
        const cookie = `theme=dark; ${headers.cookie}`;

        expect(yield* upgrade({ origin: 'https://evil.test', cookie })).toBe(403);
        expect(yield* upgrade({ origin: 'https://room.sanctum.test' })).toBe(401);
        expect(yield* upgrade({ origin: 'https://room.sanctum.test', cookie })).toBe(101);
        expect(yield* upgrade({ origin: base, cookie })).toBe(101);
        expect(yield* upgrade({ cookie })).toBe(101);
      }),
    ).pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map([['SANCTUM_ALLOWED_ORIGINS', 'https://room.sanctum.test']])))),
  );

  it.effect('maps only exact verified identities to principals, never emails or action accounts', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [ana, other] = yield* seedWorkspace('Acme', ['owner', 'member']);
        const identity = (subject: string, principal_id: string) =>
          sql`INSERT INTO principal_identities (issuer, subject, principal_id, email, verified_at)
            VALUES ('https://issuer.test', ${subject}, ${principal_id}, 'ana@acme.test', UTC_TIMESTAMP(6))`;
        yield* identity('Ana', ana!.principal.id);
        yield* identity('ana', other!.principal.id);
        yield* sql`INSERT INTO integration_accounts (id, workspace_id, owner_principal_id, external_user_id, provider_account_id, app_slug, status, created_at, updated_at)
          VALUES (${randomUUID()}, ${ana!.workspace_id}, ${ana!.principal.id}, 'pd-user', 'apn_1', 'google_drive', 'active', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
        const lookup = (issuer: string, subject: string) => identityPrincipal({ issuer, subject }).pipe(Effect.map(Option.getOrNull));

        expect(yield* lookup('https://issuer.test', 'Ana')).toBe(ana!.principal.id);
        expect(yield* lookup('https://issuer.test', 'ana')).toBe(other!.principal.id);
        expect(yield* lookup('https://issuer.test', 'ANA')).toBeNull();
        expect(yield* lookup('https://ISSUER.test', 'Ana')).toBeNull();
        expect(yield* lookup('https://issuer.test', 'ana@acme.test')).toBeNull();
        expect(yield* lookup('pipedream', 'pd-user')).toBeNull();
      }),
      { migrated: true },
    ),
  );

  it('requires authentication on every API group except process health', () => {
    const groups = Object.values(SanctumApi.groups);
    expect(groups.map(group => group.identifier)).toContain('agents');
    const open = groups.filter(group => ![...group.middlewares].includes(Authenticated as never)).map(group => group.identifier);
    expect(open).toEqual(['health']);
  });

  it('keys cached access by workspace, principal, revision, scopes and meeting access', () => {
    const access = fixtureAccess();
    const key = scopedCacheKey(access, 'context', 42);
    expect(scopedCacheKey({ ...access, scopes: [...access.scopes].reverse() }, 'context', 42)).toBe(key);
    const variants: ReadonlyArray<AccessScope> = [
      { ...access, workspace_id: fixtureAccess().workspace_id },
      { ...access, principal: { ...access.principal, id: fixtureAccess().principal.id } },
      { ...access, permission_revision: access.permission_revision + 1 },
      { ...access, scopes: ['context:read'] },
      { ...access, meetings: { kind: 'allowlist', meeting_ids: [] } },
    ];
    for (const variant of variants) expect(scopedCacheKey(variant, 'context', 42)).not.toBe(key);
    expect(scopedCacheKey(access, 'context', 43)).not.toBe(key);
    expect(scopedCacheKey(access, 'a:b', 'c')).not.toBe(scopedCacheKey(access, 'a', 'b:c'));
  });
});
