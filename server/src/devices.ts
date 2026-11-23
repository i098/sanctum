import { randomBytes, randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from '@effect/platform';
import { SqlClient, SqlSchema, type Statement } from '@effect/sql';
import {
  type AccessScope, AgentCredentialId, CurrentAccess, Device, type DeviceAuthorization, DeviceCapabilities,
  DeviceId, type DeviceToken, type DeviceTokenError, Forbidden, NotFound, PrincipalId, Unavailable, WorkspaceId,
} from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Config, Effect, Layer, Option, Schema } from 'effect';
import { AgentsLive } from './agents.ts';
import { hashToken, newToken, requireScope } from './auth.ts';
import { DbJson, DbSafeInt, DbUtc, ER_DUP_ENTRY, mysqlErrno } from './db.ts';
import { bumpPermissionRevision } from './store.ts';

const EXPIRES_IN = 600;
const POLL_INTERVAL = 5;
const PAIRING_CAPACITY = 1_000;
const ADDRESS_CAPACITY = 5;
const MAX_MISSES = 5;
const noStore = { 'cache-control': 'no-store' };

const find = <A, I>(Result: Schema.Schema<A, I>, query: Statement.Statement<unknown>) =>
  SqlSchema.findAll({ Request: Schema.Void, Result, execute: () => query })(undefined);
const PendingCounts = Schema.Struct({ total: DbSafeInt, by_address: DbSafeInt });

const unavailable = () => new Unavailable({ message: 'Device pairing is temporarily unavailable', retryable: true });
const missing = () => new NotFound({ message: 'Device not found' });
const pollError = (error: DeviceTokenError['error']): DeviceTokenError => ({ error });

const pairingIngress = Config.all({
  proxy: Config.literal('direct', 'caddy', 'cloudflare')('SANCTUM_DEVICE_PROXY').pipe(Config.withDefault('direct')),
  signInRedirect: Config.option(Config.url('SANCTUM_OIDC_REDIRECT_URI')),
});

const addressHash = (raw: string | undefined) => {
  if (raw === undefined) return undefined;
  const address = raw.split('%', 1)[0]!;
  switch (isIP(address)) {
    case 4: return hashToken(address);
    case 6: return hashToken(new URL(`http://[${address}]`).hostname);
  }
};

const pairingRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const ingress = yield* pairingIngress.pipe(Effect.orDie);
  // Only managed ingress can opt in. Caddy replaces XFF; Cloudflare sets CF-Connecting-IP.
  const client = addressHash(ingress.proxy === 'direct' ? Option.getOrUndefined(request.remoteAddress)
    : request.headers[ingress.proxy === 'caddy' ? 'x-forwarded-for' : 'cf-connecting-ip']);
  const origin = Option.getOrElse(ingress.signInRedirect, () =>
    URL.parse(`${ingress.proxy === 'direct' ? 'http' : 'https'}://${request.headers.host ?? ''}`))?.origin;
  if (!client || !origin) return yield* unavailable();
  return { client, origin };
});

const authorizeDevice = (input: { name: string; capabilities: DeviceCapabilities }) => Effect.gen(function* () {
  const { client, origin } = yield* pairingRequest;
  const sql = yield* SqlClient.SqlClient;
  const grant = yield* sql.withTransaction(Effect.gen(function* () {
    yield* sql`INSERT INTO device_pair_capacity (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id`;
    yield* sql`DELETE FROM devices WHERE status IN ('pending', 'denied') AND expires_at <= UTC_TIMESTAMP(6)`;
    const [pending] = yield* find(PendingCounts, sql`SELECT COUNT(*) AS total,
      COUNT(CASE WHEN client_address_hash = ${client} THEN 1 END) AS by_address FROM devices WHERE status = 'pending'`);
    if (pending!.total >= PAIRING_CAPACITY || pending!.by_address >= ADDRESS_CAPACITY) return Option.none<DeviceAuthorization>();

    const insert = Effect.suspend(() => {
      const device_code = newToken();
      const digits = String(randomInt(100_000_000)).padStart(8, '0');
      const verification_uri = `${origin}/pair`;
      return sql`INSERT INTO devices (id, name, capabilities, device_code_hash, user_code_hash, client_address_hash, expires_at, created_at)
        VALUES (${crypto.randomUUID()}, ${input.name}, ${JSON.stringify(input.capabilities)}, ${hashToken(device_code)}, ${hashToken(digits)}, ${client},
          TIMESTAMPADD(SECOND, ${EXPIRES_IN}, UTC_TIMESTAMP(6)), UTC_TIMESTAMP(6))`.pipe(Effect.as({
        device_code, user_code: `${digits.slice(0, 4)}-${digits.slice(4)}`, verification_uri, verification_uri_complete: `${verification_uri}?code=${digits}`,
        expires_in: EXPIRES_IN, interval: POLL_INTERVAL,
      } satisfies DeviceAuthorization));
    });
    return yield* insert.pipe(Effect.retry({ times: 3, while: error => mysqlErrno(error) === ER_DUP_ENTRY }), Effect.map(Option.some));
  })).pipe(Effect.catchTags({ SqlError: () => unavailable(), ParseError: Effect.die }));
  return yield* Option.match(grant, { onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed });
});

const Grant = Schema.Struct({
  id: DeviceId,
  status: Device.fields.status,
  workspace_id: Schema.NullOr(WorkspaceId),
  credential_id: Schema.NullOr(AgentCredentialId),
  delivered: DbSafeInt,
  expired: DbSafeInt,
  early: DbSafeInt,
});

const redeemDeviceToken = (sql: SqlClient.SqlClient, grant: typeof Grant.Type) => Effect.gen(function* () {
  const [owner] = yield* find(Schema.Struct({ approved_by_name: Schema.String, workspace_name: Schema.String }), sql`
    SELECT COALESCE(p.display_name, 'Unnamed member') AS approved_by_name, w.name AS workspace_name
    FROM agent_credentials c JOIN workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
    JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.principal_id = c.principal_id AND m.revoked_at IS NULL
    JOIN principals p ON p.id = m.principal_id AND p.disabled_at IS NULL
    WHERE c.id = ${grant.credential_id} AND c.workspace_id = ${grant.workspace_id} AND c.revoked_at IS NULL`);
  if (!owner || grant.workspace_id === null) return pollError('access_denied');
  const access_token = newToken();
  yield* sql`UPDATE agent_credentials SET token_hash = ${hashToken(access_token)} WHERE id = ${grant.credential_id}`;
  yield* sql`UPDATE devices SET token_delivered_at = UTC_TIMESTAMP(6) WHERE id = ${grant.id}`;
  return { access_token, token_type: 'Bearer', device_id: grant.id, workspace_id: grant.workspace_id, ...owner } satisfies DeviceToken;
});

const deviceToken = (code: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(Effect.gen(function* () {
    const [grant] = yield* find(Grant, sql`SELECT id, status, workspace_id, credential_id, token_delivered_at IS NOT NULL AS delivered,
        expires_at <= UTC_TIMESTAMP(6) AS expired,
        COALESCE(TIMESTAMPADD(SECOND, poll_interval_seconds, last_polled_at) > UTC_TIMESTAMP(6), FALSE) AS early
      FROM devices WHERE device_code_hash = ${hashToken(code)} FOR UPDATE`);
    if (!grant || grant.delivered) return pollError('invalid_grant');
    if (grant.expired) return pollError('expired_token');
    if (grant.status === 'denied' || grant.status === 'revoked') return pollError('access_denied');
    if (grant.status === 'pending' || grant.early) {
      yield* sql`UPDATE devices SET last_polled_at = UTC_TIMESTAMP(6),
        poll_interval_seconds = poll_interval_seconds + ${grant.early * POLL_INTERVAL} WHERE id = ${grant.id}`;
      return pollError(grant.early ? 'slow_down' : 'authorization_pending');
    }
    return yield* redeemDeviceToken(sql, grant);
  })).pipe(Effect.orDie);
});

const checkManager = (access: AccessScope) => Effect.gen(function* () {
  if (access.principal.kind !== 'human') return yield* new Forbidden({ message: 'Only a person can manage devices' });
  yield* requireScope(access, 'capture:ingest');
  yield* requireScope(access, 'context:write');
});

const Pending = Schema.Struct({ id: DeviceId, name: Schema.String, capabilities: DbJson(DeviceCapabilities), expires_at: DbUtc });
const AttemptTimes = Schema.Struct({ attempts: DbJson(Schema.Array(Schema.Number)) });
const PairingClock = Schema.Struct({ now_ms: DbSafeInt });

// A principal lock serializes both endpoints. Keep misses in a rolling 10-minute window.
const withPending = <A>(access: AccessScope, code: string, use: (pending: typeof Pending.Type) => Effect.Effect<A, never, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    yield* checkManager(access);
    const sql = yield* SqlClient.SqlClient;
    const result = yield* sql.withTransaction(Effect.gen(function* () {
      const principal = access.principal.id;
      const [clock] = yield* find(PairingClock, sql`SELECT CAST(UNIX_TIMESTAMP(UTC_TIMESTAMP(6)) * 1000 AS UNSIGNED) AS now_ms FROM principals WHERE id = ${principal} FOR UPDATE`);
      const now = clock!.now_ms;
      const [row] = yield* find(AttemptTimes, sql`SELECT attempts FROM device_pair_attempts WHERE principal_id = ${principal}`);
      const attempts = row?.attempts.filter(time => time > now - 600_000) ?? [];
      if (attempts.length >= MAX_MISSES) return yield* new Forbidden({ message: 'Too many incorrect device codes. Try again in 10 minutes.' });
      const digits = code.replace(/[-\s]/g, '');
      if (/^\d{8}$/.test(digits)) {
        const [pending] = yield* find(Pending, sql`SELECT id, name, capabilities, expires_at FROM devices
          WHERE pending_code_hash = ${hashToken(digits)} AND expires_at > UTC_TIMESTAMP(6) FOR UPDATE`);
        if (pending) return Option.some(yield* use(pending));
      }
      yield* sql`INSERT INTO device_pair_attempts (principal_id, attempts) VALUES (${principal}, ${JSON.stringify([...attempts, now])}) AS incoming
        ON DUPLICATE KEY UPDATE attempts = incoming.attempts`;
      return Option.none<A>();
    })).pipe(Effect.catchTags({ SqlError: Effect.die, ParseError: Effect.die }));
    return yield* Option.match(result, { onNone: () => Effect.fail(missing()), onSome: Effect.succeed });
  });

const DeviceRow = Schema.Struct({
  ...Device.fields,
  capabilities: DbJson(DeviceCapabilities),
  approved_by: Schema.NullOr(PrincipalId),
  display_name: Schema.NullOr(Schema.String),
  created_at: DbUtc,
  approved_at: Schema.NullOr(DbUtc),
  last_used_at: Schema.NullOr(DbUtc),
  revoked_at: Schema.NullOr(DbUtc),
});

const ownedDevices = (access: AccessScope, sql: SqlClient.SqlClient) => access.scopes.includes('workspace:admin')
  ? sql`d.workspace_id = ${access.workspace_id}`
  : sql`d.workspace_id = ${access.workspace_id} AND d.approved_by = ${access.principal.id}`;

const readDevices = (sql: SqlClient.SqlClient, where: Statement.Fragment) =>
  find(DeviceRow, sql`SELECT d.id, d.name, d.capabilities, d.status, d.approved_by, p.display_name, d.created_at, d.approved_at,
      c.last_used_at, d.revoked_at FROM devices d LEFT JOIN principals p ON p.id = d.approved_by
    LEFT JOIN agent_credentials c ON c.workspace_id = d.workspace_id AND c.id = d.credential_id
    WHERE ${where} ORDER BY d.created_at DESC, d.id`).pipe(
    Effect.orDie,
    Effect.map(rows => rows.map(({ approved_by, display_name, ...device }): Device => ({
      ...device, approved_by: approved_by === null ? null : { id: approved_by, kind: 'human', display_name },
    }))),
  );

const approveDevice = (access: AccessScope, code: string, approve: boolean) =>
  withPending(access, code, ({ id }) => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (approve) {
      const credential = crypto.randomUUID();
      // Reserve the credential now. Its random hash has no known token until redemption.
      yield* sql`INSERT INTO agent_credentials (id, workspace_id, principal_id, owner_principal_id, token_hash, scopes, created_at)
        VALUES (${credential}, ${access.workspace_id}, ${access.principal.id}, ${access.principal.id}, ${randomBytes(32)}, '["capture:ingest"]', UTC_TIMESTAMP(6))`;
      yield* sql`UPDATE devices SET status = 'approved', workspace_id = ${access.workspace_id}, approved_by = ${access.principal.id},
        credential_id = ${credential}, approved_at = UTC_TIMESTAMP(6) WHERE id = ${id}`;
    } else {
      yield* sql`UPDATE devices SET status = 'denied' WHERE id = ${id}`;
    }
    const [device] = yield* readDevices(sql, sql`d.id = ${id}`);
    return device!;
  }).pipe(Effect.orDie));

const listDevices = (access: AccessScope) => Effect.gen(function* () {
  yield* checkManager(access);
  const sql = yield* SqlClient.SqlClient;
  return { items: yield* readDevices(sql, ownedDevices(access, sql)) };
});

const revokeDevice = (access: AccessScope, id: DeviceId) => Effect.gen(function* () {
  yield* checkManager(access);
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(Effect.gen(function* () {
    const [device] = yield* find(Schema.Struct({ credential_id: AgentCredentialId, status: Device.fields.status }), sql`
      SELECT d.credential_id, d.status FROM devices d WHERE d.id = ${id} AND ${ownedDevices(access, sql)} FOR UPDATE`).pipe(Effect.orDie);
    if (!device) return yield* missing();
    if (device.status === 'revoked') return;
    yield* sql`UPDATE devices SET status = 'revoked', revoked_at = UTC_TIMESTAMP(6) WHERE id = ${id}`.pipe(Effect.orDie);
    yield* sql`UPDATE agent_credentials SET revoked_at = UTC_TIMESTAMP(6) WHERE id = ${device.credential_id}`.pipe(Effect.orDie);
    yield* bumpPermissionRevision(access.workspace_id).pipe(Effect.orDie);
  })).pipe(Effect.catchTag('SqlError', Effect.die));
});

const PairingLive = HttpApiBuilder.group(SanctumApi, 'devicePairing', handlers => handlers
  .handle('authorizeDevice', ({ payload }) => Effect.map(authorizeDevice(payload), grant => HttpServerResponse.unsafeJson(grant, { headers: noStore })))
  .handle('deviceToken', ({ payload }) => Effect.map(deviceToken(payload.device_code), result => HttpServerResponse.unsafeJson(result, {
    status: 'error' in result ? 400 : 200, headers: noStore,
  }))));

const ManagementLive = HttpApiBuilder.group(SanctumApi, 'devices', handlers => handlers
  .handle('pendingDevice', ({ urlParams }) => Effect.flatMap(CurrentAccess, access => withPending(access, urlParams.user_code,
    ({ name, capabilities, expires_at }) => Effect.succeed({ name, capabilities, expires_at }))))
  .handle('approveDevice', ({ payload }) => Effect.flatMap(CurrentAccess, access => approveDevice(access, payload.user_code, payload.approve)))
  .handle('listDevices', () => Effect.flatMap(CurrentAccess, listDevices))
  .handle('revokeDevice', ({ path }) => Effect.flatMap(CurrentAccess, access => revokeDevice(access, path.device_id))));

export const CredentialsLive = Layer.mergeAll(AgentsLive, PairingLive, ManagementLive);
