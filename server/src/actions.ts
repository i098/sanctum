/**
 * Stored grants, the shared action gateway and truthful receipts (plan sections 07 and 10).
 * Every internal or external agent request enters `requestAction`: authorize the actor and
 * meeting, match a stored human-created grant, fix idempotency, persist, then enqueue. The
 * worker (executor.ts) re-checks the grant immediately before the external write.
 */
import { createHash, randomUUID } from 'node:crypto';
import { HttpApiBuilder } from '@effect/platform';
import { SqlClient, SqlSchema } from '@effect/sql';
import {
  type AccessScope,
  type ActionGrant,
  ActionGrantId,
  ActionId,
  type ActionReceipt,
  ActionState,
  type CreateActionGrantInput,
  CurrentAccess,
  Forbidden,
  HashConflict,
  IntegrationAccountId,
  MeetingId,
  NotFound,
  PrincipalId,
  type RequestActionInput,
  type RequestActionOutput,
  type ResolveActionInput,
  SanctumApi,
  WorkspaceId,
} from '@sanctum/contracts';
import { Effect, Option, Schema } from 'effect';
import { authorizeMeeting, requireScope } from './auth.ts';
import { DbJson, DbSafeInt, DbSha256, DbUtc, ER_DUP_ENTRY, mysqlErrno } from './db.ts';
import { enqueueJob } from './jobs.ts';

type ActionRequest = typeof RequestActionInput.Type;
type Args = Readonly<Record<string, unknown>>;

const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const Restrictions = Schema.Record({ key: Schema.String, value: Schema.Array(Schema.Unknown) });

/** JSON with object keys sorted at every depth, so equal requests hash equally. */
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)))
      : inner,
  );

const requestHash = (input: ActionRequest) =>
  createHash('sha256')
    .update(canonical({ action_key: input.action_key, version: input.version, configuration_ref: input.configuration_ref, meeting_id: input.meeting_id, arguments: input.arguments }))
    .digest('hex');

/** Each restricted argument must be present and every value it carries must be listed. */
const restrictionsAllow = (restrictions: typeof Restrictions.Type, args: Args) =>
  Object.entries(restrictions).every(([key, allowed]) => {
    if (!(key in args)) return false;
    const permitted = new Set(allowed.map(canonical));
    const values: ReadonlyArray<unknown> = Array.isArray(args[key]) ? args[key] : [args[key]];
    return values.length > 0 && values.every(value => permitted.has(canonical(value)));
  });

const ActionRow = Schema.Struct({
  id: ActionId,
  workspace_id: WorkspaceId,
  meeting_id: Schema.NullOr(MeetingId),
  requested_by: PrincipalId,
  action_key: Schema.String,
  account_id: Schema.NullOr(IntegrationAccountId),
  args: DbJson(JsonRecord),
  args_sha256: DbSha256,
  configuration_ref: Schema.NullOr(Schema.String),
  version: Schema.String,
  grant_id: Schema.NullOr(ActionGrantId),
  grant_version: Schema.NullOr(DbSafeInt),
  state: ActionState,
  provider_idempotency_key: Schema.NullOr(Schema.String),
  provider_receipt: Schema.NullOr(DbJson(JsonRecord)),
  attempts: DbSafeInt,
  reconciliation: Schema.Literal('none', 'pending', 'reconciled'),
  updated_at: DbUtc,
});
export type ActionRow = typeof ActionRow.Type;

const GrantRow = Schema.Struct({
  id: ActionGrantId,
  owner_principal_id: PrincipalId,
  grantee_principal_id: PrincipalId,
  action_key: Schema.String,
  app_slug: Schema.String,
  account_id: IntegrationAccountId,
  meeting_id: Schema.NullOr(MeetingId),
  restrictions: DbJson(Restrictions),
  expires_at: Schema.NullOr(DbUtc),
  revoked_at: Schema.NullOr(DbUtc),
  version: DbSafeInt,
});

const toGrant = (row: typeof GrantRow.Type): ActionGrant => ({
  id: row.id,
  owner: row.owner_principal_id,
  grantee: row.grantee_principal_id,
  action_key: row.action_key,
  app: row.app_slug,
  account_id: row.account_id,
  meeting_id: row.meeting_id,
  restrictions: row.restrictions,
  expires_at: row.expires_at,
  revoked_at: row.revoked_at,
  version: row.version,
});

const toReceipt = (row: ActionRow): ActionReceipt => ({
  action_id: row.id,
  action_key: row.action_key,
  meeting_id: row.meeting_id,
  state: row.state,
  args_sha256: row.args_sha256,
  grant: row.grant_id === null || row.grant_version === null ? null : { id: row.grant_id, version: row.grant_version },
  provider_receipt: row.provider_receipt,
  attempts: row.attempts,
  reconciliation: row.reconciliation,
  updated_at: row.updated_at,
});

const ACTION_COLUMNS = 'id, workspace_id, meeting_id, requested_by, action_key, account_id, args, args_sha256, configuration_ref, version, grant_id, grant_version, state, provider_idempotency_key, provider_receipt, attempts, reconciliation, updated_at';
const GRANT_COLUMNS = 'g.id, g.owner_principal_id, g.grantee_principal_id, g.action_key, g.app_slug, g.account_id, g.meeting_id, g.restrictions, g.expires_at, g.revoked_at, g.version';

/** Loads one action row; `lock` takes a row lock inside the caller's transaction. */
export const loadAction = (workspace_id: WorkspaceId, id: ActionId, lock = false) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOne({
      Request: Schema.Void,
      Result: ActionRow,
      execute: () => sql`SELECT ${sql.literal(ACTION_COLUMNS)} FROM actions WHERE workspace_id = ${workspace_id} AND id = ${id} ${sql.literal(lock ? 'FOR UPDATE' : '')}`,
    })(undefined);
  });

const findByIdempotencyKey = (access: AccessScope, key: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOne({
      Request: Schema.Void,
      Result: ActionRow,
      execute: () =>
        sql`SELECT ${sql.literal(ACTION_COLUMNS)} FROM actions WHERE workspace_id = ${access.workspace_id} AND requested_by = ${access.principal.id} AND idempotency_key = ${key}`,
    })(undefined);
  });

/** A repeated key returns the original action; the same key with different content is a conflict. */
const replay = (row: ActionRow, sha256: string) =>
  row.args_sha256 === sha256
    ? Effect.succeed<typeof RequestActionOutput.Type>({ action_id: row.id, state: row.state })
    : Effect.fail(new HashConflict({ message: 'Idempotency key was used for a different request', existing_sha256: row.args_sha256 }));

/** Active, unexpired grants to this principal for this action, meeting and an active account. */
const matchGrant = (access: AccessScope, input: ActionRequest) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const grants = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: GrantRow,
      execute: () => sql`
                SELECT ${sql.literal(GRANT_COLUMNS)} FROM action_grants g
                JOIN integration_accounts a ON a.workspace_id = g.workspace_id AND a.id = g.account_id
                WHERE g.workspace_id = ${access.workspace_id} AND g.grantee_principal_id = ${access.principal.id} AND g.action_key = ${input.action_key}
                    AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > UTC_TIMESTAMP(6)) AND a.status = 'active'
                    AND (g.meeting_id IS NULL OR g.meeting_id = ${input.meeting_id})
                ORDER BY g.meeting_id IS NULL, g.created_at DESC`,
    })(undefined);
    const grant = grants.find(candidate => restrictionsAllow(candidate.restrictions, input.arguments));
    if (!grant) return yield* new Forbidden({ message: 'No active grant covers this action, account and arguments' });
    return grant;
  });

/** The third integration gateway: validate, authorize, persist and enqueue one requested action. */
export const requestAction = (access: AccessScope, input: ActionRequest): Effect.Effect<typeof RequestActionOutput.Type, Forbidden | NotFound | HashConflict, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    yield* requireScope(access, 'actions:request');
    if (input.meeting_id !== null) yield* authorizeMeeting(access, input.meeting_id, 'write');
    const sha256 = requestHash(input);
    const existing = yield* findByIdempotencyKey(access, input.idempotency_key);
    if (existing._tag === 'Some') return yield* replay(existing.value, sha256);
    const grant = yield* matchGrant(access, input);
    const id = ActionId.make(randomUUID());
    const inserted = yield* sql
      .withTransaction(
        Effect.gen(function*() {
          yield* sql`
                        INSERT INTO actions (id, workspace_id, meeting_id, requested_by, action_key, account_id, idempotency_key, args, args_sha256, configuration_ref,
                            version, grant_id, grant_version, state, provider_idempotency_key, created_at, updated_at)
                        VALUES (${id}, ${access.workspace_id}, ${input.meeting_id}, ${access.principal.id}, ${input.action_key}, ${grant.account_id}, ${input.idempotency_key},
                            ${JSON.stringify(input.arguments)}, ${Buffer.from(sha256, 'hex')}, ${input.configuration_ref}, ${input.version}, ${grant.id}, ${grant.version},
                            'queued', ${`sanctum:${id}`}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
          yield* enqueueJob({ workspace_id: access.workspace_id, kind: 'action.execute', work_key: id, payload: { action_id: id }, requested_by: access.principal.id });
        }),
      )
      .pipe(
        Effect.as(true),
        Effect.catchIf(error => error._tag === 'SqlError' && mysqlErrno(error) === ER_DUP_ENTRY, () => Effect.succeed(false)),
      );
    if (inserted) return { action_id: id, state: 'queued' as const };
    const raced = yield* findByIdempotencyKey(access, input.idempotency_key);
    return yield* replay(Option.getOrThrow(raced), sha256);
  }).pipe(Effect.catchTags({ SqlError: Effect.die, ParseError: Effect.die }));

/** Visible to the requester and workspace owners/admins; anything else is NotFound. */
const visibleAction = (access: AccessScope, action_id: ActionId) =>
  Effect.flatMap(loadAction(access.workspace_id, action_id), row =>
    row._tag === 'Some' && (row.value.requested_by === access.principal.id || access.role === 'owner' || access.role === 'admin')
      ? Effect.succeed(row.value)
      : Effect.fail(new NotFound({ message: 'Action not found' })),
  );

export const getActionReceipt = (access: AccessScope, action_id: ActionId): Effect.Effect<ActionReceipt, NotFound, SqlClient.SqlClient> =>
  visibleAction(access, action_id).pipe(Effect.map(toReceipt), Effect.catchTags({ SqlError: Effect.die, ParseError: Effect.die }));

const requireHuman = (access: AccessScope, what: string) =>
  access.principal.kind === 'human' ? Effect.void : Effect.fail(new Forbidden({ message: `Only a person can ${what}` }));

/** A person records the checked outcome of an `unknown` action; automatic replay never does. */
export const resolveAction = (access: AccessScope, action_id: ActionId, input: ResolveActionInput) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    yield* requireHuman(access, 'resolve an action');
    yield* requireScope(access, 'actions:execute');
    const row = yield* visibleAction(access, action_id);
    if (row.state !== 'unknown') return yield* new Forbidden({ message: `Only unknown actions can be resolved; this one is ${row.state}` });
    yield* sql`
            UPDATE actions SET state = ${input.outcome}, provider_receipt = ${input.provider_receipt === null ? null : JSON.stringify(input.provider_receipt)},
                reconciliation = 'reconciled', updated_at = UTC_TIMESTAMP(6)
            WHERE workspace_id = ${access.workspace_id} AND id = ${action_id} AND state = 'unknown'`;
    return toReceipt(Option.getOrThrow(yield* loadAction(access.workspace_id, action_id)));
  }).pipe(Effect.catchTags({ SqlError: Effect.die, ParseError: Effect.die }));

const loadGrant = (workspace_id: WorkspaceId, id: ActionGrantId) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOne({
      Request: Schema.Void,
      Result: GrantRow,
      execute: () => sql`SELECT ${sql.literal(GRANT_COLUMNS)} FROM action_grants g WHERE g.workspace_id = ${workspace_id} AND g.id = ${id}`,
    })(undefined);
  });

/** Only the person who owns the connected account can let another principal act through it. */
export const createActionGrant = (access: AccessScope, input: CreateActionGrantInput): Effect.Effect<ActionGrant, Forbidden | NotFound, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    yield* requireHuman(access, 'create an action grant');
    if (input.meeting_id !== null) yield* authorizeMeeting(access, input.meeting_id, 'read');
    const [account] = yield* sql<{ app_slug: string }>`
            SELECT app_slug FROM integration_accounts
            WHERE workspace_id = ${access.workspace_id} AND id = ${input.account_id} AND owner_principal_id = ${access.principal.id} AND status = 'active'`;
    if (!account) return yield* new NotFound({ message: 'Connected account not found' });
    const [grantee] = yield* sql`
            SELECT 1 FROM workspace_members WHERE workspace_id = ${access.workspace_id} AND principal_id = ${input.grantee} AND revoked_at IS NULL`;
    if (!grantee) return yield* new NotFound({ message: 'Grantee not found' });
    const id = ActionGrantId.make(randomUUID());
    yield* sql`
            INSERT INTO action_grants (id, workspace_id, owner_principal_id, grantee_principal_id, action_key, app_slug, account_id, meeting_id, restrictions, expires_at, created_at)
            VALUES (${id}, ${access.workspace_id}, ${access.principal.id}, ${input.grantee}, ${input.action_key}, ${account.app_slug}, ${input.account_id},
                ${input.meeting_id}, ${JSON.stringify(input.restrictions)}, ${input.expires_at === null ? null : Schema.encodeSync(DbUtc)(input.expires_at)}, UTC_TIMESTAMP(6))`;
    return toGrant(Option.getOrThrow(yield* loadGrant(access.workspace_id, id)));
  }).pipe(Effect.catchTags({ SqlError: Effect.die, ParseError: Effect.die }));

/** Revocation bumps the version, so queued actions holding the old version stop before executing. */
export const revokeActionGrant = (access: AccessScope, grant_id: ActionGrantId): Effect.Effect<ActionGrant, NotFound, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const grant = yield* loadGrant(access.workspace_id, grant_id);
    if (grant._tag === 'None' || (grant.value.owner_principal_id !== access.principal.id && access.role !== 'owner' && access.role !== 'admin')) {
      return yield* new NotFound({ message: 'Grant not found' });
    }
    yield* sql`
            UPDATE action_grants SET revoked_at = UTC_TIMESTAMP(6), version = version + 1
            WHERE workspace_id = ${access.workspace_id} AND id = ${grant_id} AND revoked_at IS NULL`;
    return toGrant(Option.getOrThrow(yield* loadGrant(access.workspace_id, grant_id)));
  }).pipe(Effect.catchTags({ SqlError: Effect.die, ParseError: Effect.die }));

export const ActionsLive = HttpApiBuilder.group(SanctumApi, 'actions', handlers =>
  handlers
    .handle('requestAction', ({ payload }) => Effect.flatMap(CurrentAccess, access => requestAction(access, payload)))
    .handle('getAction', ({ path }) => Effect.flatMap(CurrentAccess, access => getActionReceipt(access, path.action_id)))
    .handle('resolveAction', ({ path, payload }) => Effect.flatMap(CurrentAccess, access => resolveAction(access, path.action_id, payload)))
    .handle('createActionGrant', ({ payload }) => Effect.flatMap(CurrentAccess, access => createActionGrant(access, payload)))
    .handle('revokeActionGrant', ({ path }) => Effect.flatMap(CurrentAccess, access => revokeActionGrant(access, path.grant_id))),
);
