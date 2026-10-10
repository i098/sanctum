/**
 * Settings' connect flow (contracts `IntegrationAccountsApi`). The Pipedream external user is derived
 * on the server from the caller's workspace and principal, never from client input, so a person
 * connects and sees only their own accounts in that workspace. Connecting grants nothing: grants stay
 * the owner's explicit `createActionGrant`.
 */
import { randomUUID } from 'node:crypto';
import { HttpApiBuilder } from '@effect/platform';
import { SqlClient, SqlSchema } from '@effect/sql';
import { type AccessScope, ActionGrantId, CurrentAccess, IntegrationAccountId, NotFound, Unavailable } from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Effect, Layer, Schema } from 'effect';
import { requireHuman } from './actions.ts';
import { PipedreamLive } from './integrations.ts';
import { type IntegrationFailure, PipedreamClient } from './providers/pipedream.ts';

/** The Pipedream external user of one person in one workspace; an operator finds a workspace's accounts by this prefix. */
const externalUserId = (access: AccessScope) => `${access.workspace_id}.${access.principal.id}`;

const unavailable = (error: IntegrationFailure) => new Unavailable({ message: error.message, retryable: error.retryable });

const AccountRow = Schema.Struct({ id: IntegrationAccountId, app_slug: Schema.String });
const GrantRow = Schema.Struct({ id: ActionGrantId, account_id: IntegrationAccountId, action_key: Schema.String, grantee_name: Schema.NullOr(Schema.String) });

/** The caller's active accounts in this workspace, each with the active grants its owner made on it. */
const listAccounts = (access: AccessScope) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const client = yield* PipedreamClient;
    const accounts = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: AccountRow,
      execute: () => sql`SELECT id, app_slug FROM integration_accounts
        WHERE workspace_id = ${access.workspace_id} AND owner_principal_id = ${access.principal.id} AND status = 'active'
        ORDER BY created_at, id`,
    })(undefined);
    const grants = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: GrantRow,
      execute: () => sql`SELECT g.id, g.account_id, g.action_key, COALESCE(p.display_name, p.email) AS grantee_name
        FROM action_grants g JOIN principals p ON p.id = g.grantee_principal_id
        WHERE g.workspace_id = ${access.workspace_id} AND g.owner_principal_id = ${access.principal.id}
          AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > UTC_TIMESTAMP(6))
        ORDER BY g.created_at, g.id`,
    })(undefined);
    return {
      configured: client.configured,
      accounts: accounts.map(account => ({
        id: account.id,
        app: account.app_slug,
        // The response schema drops `account_id`.
        grants: grants.filter(grant => grant.account_id === account.id),
      })),
    };
  });

/** A Connect Link for one app, scoped to the caller's external user; the browser opens it in a new tab. */
const connectIntegration = (access: AccessScope, app: string) =>
  Effect.gen(function* () {
    yield* requireHuman(access, 'connect an integration');
    const client = yield* PipedreamClient;
    const { connect_link_url } = yield* client.createConnectToken(externalUserId(access)).pipe(Effect.mapError(unavailable));
    const url = new URL(connect_link_url);
    if (url.protocol !== 'https:') return yield* new Unavailable({ message: 'Pipedream returned an unexpected Connect Link', retryable: false });
    url.searchParams.set('app', app);
    return { url: url.href };
  });

/**
 * Stores the accounts the caller connected at Pipedream; idempotent, and a row changes only when its
 * state does. An account Pipedream reports dead, or no longer lists, is stored as disconnected.
 */
const syncAccounts = (access: AccessScope) =>
  Effect.gen(function* () {
    yield* requireHuman(access, 'connect an integration');
    const sql = yield* SqlClient.SqlClient;
    const client = yield* PipedreamClient;
    if (client.configured) {
      const external = externalUserId(access);
      const listed = yield* client.listAccounts(external).pipe(Effect.mapError(unavailable));
      for (const account of listed) {
        yield* sql`INSERT INTO integration_accounts (id, workspace_id, owner_principal_id, external_user_id, provider_account_id, app_slug, status, created_at, updated_at)
          VALUES (${randomUUID()}, ${access.workspace_id}, ${access.principal.id}, ${external}, ${account.id}, ${account.app},
            ${account.dead ? 'disconnected' : 'active'}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)) AS incoming
          ON DUPLICATE KEY UPDATE
            updated_at = IF(integration_accounts.status = incoming.status, integration_accounts.updated_at, UTC_TIMESTAMP(6)),
            status = incoming.status`;
      }
      yield* sql`UPDATE integration_accounts SET status = 'disconnected', updated_at = UTC_TIMESTAMP(6)
        WHERE workspace_id = ${access.workspace_id} AND external_user_id = ${external} AND status = 'active'
          ${listed.length === 0 ? sql`` : sql`AND provider_account_id NOT IN ${sql.in(listed.map(account => account.id))}`}`;
    }
    return yield* listAccounts(access);
  });

/** Deletes the account at Pipedream first, so a failed delete leaves it connected rather than claiming it is gone. */
const disconnectAccount = (access: AccessScope, account_id: IntegrationAccountId) =>
  Effect.gen(function* () {
    yield* requireHuman(access, 'disconnect an integration');
    const sql = yield* SqlClient.SqlClient;
    const client = yield* PipedreamClient;
    const [account] = yield* sql<{ provider_account_id: string }>`SELECT provider_account_id FROM integration_accounts
      WHERE workspace_id = ${access.workspace_id} AND id = ${account_id} AND owner_principal_id = ${access.principal.id} AND status = 'active'`;
    if (!account) return yield* new NotFound({ message: 'Connected account not found' });
    yield* client.deleteAccount(account.provider_account_id).pipe(Effect.mapError(unavailable));
    yield* sql`UPDATE integration_accounts SET status = 'disconnected', updated_at = UTC_TIMESTAMP(6) WHERE workspace_id = ${access.workspace_id} AND id = ${account_id}`;
    return yield* listAccounts(access);
  });

const handled = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.catchTags({ SqlError: Effect.die, ParseError: Effect.die }));

export const IntegrationAccountsLive = HttpApiBuilder.group(SanctumApi, 'integrationAccounts', handlers =>
  handlers
    .handle('listIntegrationAccounts', () => handled(Effect.flatMap(CurrentAccess, listAccounts)))
    .handle('syncIntegrationAccounts', () => handled(Effect.flatMap(CurrentAccess, syncAccounts)))
    .handle('disconnectIntegrationAccount', ({ path }) => handled(Effect.flatMap(CurrentAccess, access => disconnectAccount(access, path.account_id))))
    .handle('connectIntegration', ({ payload }) => Effect.flatMap(CurrentAccess, access => connectIntegration(access, payload.app))),
).pipe(Layer.provide(PipedreamLive));
