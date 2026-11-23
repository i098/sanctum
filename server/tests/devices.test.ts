import { SqlClient } from '@effect/sql';
import { expect, it } from '@effect/vitest';
import type { DeviceAuthorization, DeviceToken } from '@sanctum/contracts';
import { ConfigProvider, Effect } from 'effect';
import { hashToken, openSession } from '../src/auth.ts';
import { MCP_TOOL_NAMES } from '../src/mcp.ts';
import { serveApiWithDb } from './http-server.ts';
import { seedWorkspace } from './support/fixtures.ts';

const capabilities = { mic: true, screen: false, light: 'mono', speaker: false } as const;
const grant_type = 'urn:ietf:params:oauth:grant-type:device_code';
const listenerName = 'Room listener';
const bearer = ({ access_token }: DeviceToken) => ({ authorization: `Bearer ${access_token}` });
const session = (access: Parameters<typeof openSession>[0]) => Effect.map(openSession(access), ({ token, csrf_token }) => ({
  cookie: `sanctum_session=${token}`,
  'x-csrf-token': csrf_token,
}));

const withApi = <A, E>(use: (base: string) => Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.flatMap(serveApiWithDb(), ({ base, db }) => Effect.provide(use(base), db));

const api = (base: string) => {
  const call = <T = unknown>(path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => Effect.promise(async () => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: options.body === undefined ? null : JSON.stringify(options.body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T, cache: response.headers.get('cache-control') };
  });
  return {
    call,
    authorize: (headers?: Record<string, string>) => call<DeviceAuthorization>('/device/authorize', { method: 'POST', headers: headers ?? {}, body: { name: listenerName, capabilities } }),
    poll: (device_code: string) => call<DeviceToken>('/device/token', { method: 'POST', body: { grant_type, device_code } }),
    pending: (userCode: string, headers: Record<string, string>) => call(`/device/pending?user_code=${encodeURIComponent(userCode)}`, { headers }),
    approve: (user_code: string, headers: Record<string, string>, approve = true) => call('/device/approve', { method: 'POST', headers, body: { user_code, approve } }),
    list: (headers: Record<string, string>) => call('/devices', { headers }),
    revoke: (id: string, headers: Record<string, string>) => call(`/devices/${id}`, { method: 'DELETE', headers }),
  };
};

it.scoped('pairs a new capture-only listener once and revokes it within its workspace', () => withApi(base => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [owner, member, peer] = yield* seedWorkspace('Room team', ['owner', 'member', 'member']);
  const [foreign] = yield* seedWorkspace('Another team', ['owner']);
  const signedIn = (user: typeof member) => session({ workspace_id: user!.workspace_id, principal_id: user!.principal.id });
  const [admin, approver, other, outside] = yield* Effect.all([owner, member, peer, foreign].map(signedIn));
  const http = api(base);
  const grant = yield* http.authorize();
  expect(grant).toMatchObject({ status: 200, cache: 'no-store', body: { verification_uri: `${base}/pair`, expires_in: 600, interval: 5 } });
  const { device_code, user_code, verification_uri_complete } = grant.body;
  const digits = user_code.replace('-', '');
  expect(verification_uri_complete).toBe(`${base}/pair?code=${digits}`);
  expect(yield* http.pending(user_code, approver!)).toMatchObject({ status: 200, body: { name: listenerName, capabilities } });
  expect(yield* http.poll(device_code)).toMatchObject({ status: 400, body: { error: 'authorization_pending' } });
  expect(yield* http.poll(device_code)).toMatchObject({ status: 400, body: { error: 'slow_down' } });
  yield* sql`UPDATE devices SET last_polled_at = UTC_TIMESTAMP(6) - INTERVAL 9 SECOND WHERE device_code_hash = ${hashToken(device_code)}`;
  expect(yield* http.poll(device_code)).toMatchObject({ status: 400, body: { error: 'slow_down' } });
  expect(yield* http.approve(`${digits.slice(0, 4)} ${digits.slice(4)}`, approver!)).toMatchObject({
    status: 200, body: { status: 'approved', approved_by: { id: member!.principal.id } },
  });
  const [reserved] = yield* sql`SELECT c.scopes, c.principal_id, c.owner_principal_id, c.expires_at FROM devices d
    JOIN agent_credentials c ON c.id = d.credential_id WHERE d.device_code_hash = ${hashToken(device_code)}`;
  expect(reserved).toMatchObject({
    scopes: ['capture:ingest'], principal_id: member!.principal.id, owner_principal_id: member!.principal.id, expires_at: null,
  });
  expect((yield* http.pending(user_code, approver!)).status).toBe(404);
  yield* sql`UPDATE devices SET last_polled_at = UTC_TIMESTAMP(6) - INTERVAL 16 SECOND WHERE device_code_hash = ${hashToken(device_code)}`;
  yield* sql`UPDATE devices SET expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE device_code_hash = ${hashToken(device_code)}`;
  const polls = yield* Effect.all([http.poll(device_code), http.poll(device_code)], { concurrency: 2 });
  const issued = polls.find(result => result.status === 200)!;
  expect(issued).toMatchObject({ status: 200, cache: 'no-store', body: { token_type: 'Bearer', workspace_id: member!.workspace_id, workspace_name: 'Room team' } });
  expect(issued.body.approved_by_name).toBe('Room team member');
  expect(polls.find(result => result.status === 400)).toMatchObject({ body: { error: 'invalid_grant' } });
  const { device_id, access_token } = issued.body;
  const headers = bearer(issued.body);
  expect(yield* http.call('/session', { headers })).toMatchObject({ status: 200, body: { principal: { id: member!.principal.id }, scopes: ['capture:ingest'] } });
  const registration = yield* http.call<{ id: string }>('/listeners', { method: 'POST', headers, body: { name: listenerName, mode: 'room', capabilities: { device: capabilities } } });
  expect(registration.status).toBe(201);
  const heartbeat = (id = registration.body.id) => http.call(`/listeners/${id}/heartbeat`, {
    method: 'POST', headers, body: { lease_generation: 0, state: 'starting', epoch_id: null, buffered_chunks: 0, storage_bytes_free: null },
  });
  expect(yield* heartbeat()).toMatchObject({ status: 200, body: { owner: true } });
  const browser = yield* http.call<{ id: string }>('/listeners', {
    method: 'POST', headers: approver!, body: { name: 'Browser', mode: 'room', capabilities: {} },
  });
  expect(browser.status).toBe(201);
  expect((yield* heartbeat(browser.body.id)).status).toBe(404);
  expect((yield* http.call('/context/search?q=device', { headers })).status).toBe(403);
  expect((yield* http.approve(user_code, headers)).status).toBe(403);
  expect((yield* http.list(headers)).status).toBe(403);
  expect((yield* http.revoke(device_id, headers)).status).toBe(403);
  expect(yield* http.call('/agents', { headers: admin! })).toMatchObject({ status: 200, body: { items: [] } });
  expect(yield* http.list(other!)).toMatchObject({ status: 200, body: { items: [] } });
  expect((yield* http.revoke(device_id, other!)).status).toBe(404);
  expect((yield* http.revoke(device_id, outside!)).status).toBe(404);
  expect(yield* http.list(approver!)).toMatchObject({ body: { items: [{ id: device_id, last_used_at: expect.any(String) }] } });
  const [hashes] = yield* sql`SELECT d.device_code_hash, d.user_code_hash, c.token_hash FROM devices d JOIN agent_credentials c ON c.id = d.credential_id WHERE d.id = ${device_id}`;
  expect(hashes).toEqual({ device_code_hash: hashToken(device_code), user_code_hash: hashToken(digits), token_hash: hashToken(access_token) });
  expect((yield* http.revoke(device_id, admin!)).status).toBe(204);
  expect((yield* heartbeat()).status).toBe(401);
  expect(yield* http.list(approver!)).toMatchObject({ body: { items: [{ id: device_id, status: 'revoked', revoked_at: expect.any(String) }] } });
  expect(MCP_TOOL_NAMES.some(name => name.startsWith('device'))).toBe(false);
})));

it.scoped('rejects denied, expired and unknown codes and locks a principal after five misses', () => withApi(base => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [owner, second, device] = yield* seedWorkspace('Team', ['owner', 'member', 'device']);
  const signedIn = (user: typeof owner) => session({ workspace_id: user!.workspace_id, principal_id: user!.principal.id });
  const [person, other, nonHuman] = yield* Effect.all([owner, second, device].map(signedIn));
  const http = api(base);
  const first = (yield* http.authorize()).body;
  expect(yield* http.approve(first.user_code, person!, false)).toMatchObject({ status: 200, body: { status: 'denied' } });
  expect(yield* http.poll(first.device_code)).toMatchObject({ status: 400, body: { error: 'access_denied' } });
  const expired = (yield* http.authorize()).body;
  yield* sql`UPDATE devices SET expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE device_code_hash = ${hashToken(expired.device_code)}`;
  expect(yield* http.poll(expired.device_code)).toMatchObject({ status: 400, body: { error: 'expired_token' } });
  expect((yield* http.pending(expired.user_code, person!)).status).toBe(404);
  expect(yield* http.poll('unknown')).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  for (let i = 0; i < 4; i++) expect((yield* http.pending(String(i), person!)).status).toBe(404);
  expect((yield* http.approve('not a code', person!)).status).toBe(403);
  expect((yield* http.pending('not a code', other!)).status).toBe(404);
  expect((yield* http.pending(first.user_code, nonHuman!)).status).toBe(403);
  yield* sql`UPDATE device_pair_attempts SET attempts = '[0,0,0,0,0]' WHERE principal_id = ${owner!.principal.id}`;
  expect((yield* http.pending('not a code', person!)).status).toBe(404);
})));

it.scoped('limits pending grants by socket address even when clients supply different forwarded addresses', () => withApi(base => Effect.gen(function* () {
  const http = api(base);
  const grants = yield* Effect.forEach([1, 2, 3, 4, 5, 6], index => http.authorize({ 'x-forwarded-for': `192.0.2.${index}` }), { concurrency: 6 });
  expect(grants.map(grant => grant.status).sort()).toEqual([200, 200, 200, 200, 200, 503]);
})));

it.scoped('applies the IPv6 quota to a prefix and keeps IPv4 clients separate', () => withApi(base => Effect.gen(function* () {
  const http = api(base);
  const authorize = (ip: string) => http.authorize({ 'x-forwarded-for': ip });
  const hosts = ['2001:db8::1', '2001:db8:0:0:ffff:1234:5678:9abc', '2001:db8:0:0:1::1', '2001:db8::a:b:c:d', '2001:db8:0:0::5'];
  const grants = yield* Effect.forEach(hosts, authorize);
  expect(grants.map(grant => grant.status)).toEqual([200, 200, 200, 200, 200]);
  expect((yield* authorize('2001:db8::6')).status).toBe(503);
  expect((yield* authorize('2001:db8:0:1::1')).status).toBe(200);
  expect((yield* authorize('192.0.2.1')).status).toBe(200);
})).pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map([['SANCTUM_DEVICE_PROXY', 'caddy']]))
  .pipe(ConfigProvider.orElse(ConfigProvider.fromEnv)))));

it.scoped('enforces the global grant cap and frees capacity when a grant expires', () => withApi(base => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO devices (id, name, capabilities, device_code_hash, user_code_hash, client_address_hash, created_at, expires_at)
    WITH RECURSIVE sequence AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM sequence WHERE n < 1000)
    SELECT UUID(), ${listenerName}, ${JSON.stringify(capabilities)}, UNHEX(SHA2(CONCAT('device ', n), 256)),
      UNHEX(SHA2(CONCAT('user ', n), 256)), ${hashToken('fixture-address')}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6) + INTERVAL 10 MINUTE
    FROM sequence`;
  const http = api(base);
  expect((yield* http.authorize()).status).toBe(503);
  yield* sql`UPDATE devices SET expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE user_code_hash = ${hashToken('user 1')}`;
  expect((yield* http.authorize()).status).toBe(200);
})));
