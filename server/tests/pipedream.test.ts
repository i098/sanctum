import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpServer } from '@effect/platform';
import { SqlClient } from '@effect/sql';
import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest';
import {
  type AccessScope,
  GetIntegrationActionInput,
  IntegrationAccountId,
  MeetingId,
  RequestActionInput,
  SearchIntegrationActionsInput,
  Unauthenticated,
} from '@sanctum/contracts';
import { ConfigProvider, Context, Effect, Either, JSONSchema, Layer, Option, Redacted, Schema } from 'effect';
import { Authenticator, openSession, resolveAccess } from '../src/auth.ts';
import { engineeringDefaults } from '../src/config.ts';
import { activeActionGrants, createActionGrant, requestAction, revokeActionGrant } from '../src/actions.ts';
import { dbLayer } from '../src/db.ts';
import { executeAction } from '../src/executor.ts';
import { executeIntegrationAction, getIntegrationAction, IntegrationFailure, searchIntegrationActions, uploadDriveFile } from '../src/integrations.ts';
import { serverLayer } from '../src/main.ts';
import { loadMigrations, migrate } from '../src/migrate.ts';
import { type ActionProp, makePipedreamClient, type PipedreamClient } from '../src/providers/pipedream.ts';
import { actionRow, queuedJob, seedCredential, seedMeeting } from './support/actions.ts';
import { type FixtureAction, fixturePipedream, type PipedreamFixture } from './support/pipedream.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

const budget = engineeringDefaults.pipedream.outputBudgetBytes;
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');

const action = (app: string, slug: string, name: string, props: ReadonlyArray<ActionProp> = [], extra: Partial<FixtureAction> = {}): FixtureAction => ({
  key: `${app}-${slug}`,
  name,
  version: '0.1.0',
  description: `${name} in ${app}.\nLonger documentation that never reaches search results.`,
  configurable_props: [{ name: app, type: 'app', app }, ...props],
  ...extra,
});

const sendEmail = action('gmail', 'send-email', 'Send Email', [
  { name: 'to', type: 'string[]' },
  { name: 'subject', type: 'string' },
  { name: 'body', type: 'string', optional: true },
]);
const listFiles = action('google_drive', 'list-files', 'List Files', [{ name: 'query', type: 'string', optional: true }], { annotations: { readOnlyHint: true } });
const addRow = action('google_sheets', 'add-row', 'Add Row', [{ name: 'sheetId', type: 'string', remoteOptions: true, reloadProps: true }], {
  dynamicProps: configured => (configured.sheetId === 'sheet-a' ? [{ name: 'col_a', type: 'string' }] : [{ name: 'col_b', type: 'integer' }]),
});
const channels = Array.from({ length: 130 }, (_, index) => ({ label: `#channel-${index}`, value: `C${index}` }));
const postMessage = action('slack', 'post-message', 'Post Message', [{ name: 'channel', type: 'string', remoteOptions: true }, { name: 'text', type: 'string' }], {
  options: { channel: channels },
});
const baseCatalog = [sendEmail, listFiles, addRow, postMessage];

const syntheticCatalog = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    action(`app_${index % 250}`, `op-${index}`, `${['Create', 'List', 'Update', 'Delete'][index % 4]} record ${index}`, [{ name: 'record', type: 'string' }]),
  );

/** Active connected account owned by `owner`, as the Connect flow would store it. */
const connect = (owner: AccessScope, app: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const id = IntegrationAccountId.make(randomUUID());
    yield* sql`INSERT INTO integration_accounts (id, workspace_id, owner_principal_id, external_user_id, provider_account_id, app_slug, status, created_at, updated_at)
      VALUES (${id}, ${owner.workspace_id}, ${owner.principal.id}, ${`ext-${owner.principal.id}`}, ${`apn_${id.slice(0, 8)}`}, ${app}, 'active', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    return id;
  });

const grant = (owner: AccessScope, grantee: AccessScope, account: IntegrationAccountId, meeting: MeetingId | null = null) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const id = randomUUID();
    yield* sql`INSERT INTO action_grants (id, workspace_id, owner_principal_id, grantee_principal_id, action_key, app_slug, account_id, meeting_id, restrictions, created_at)
      VALUES (${id}, ${owner.workspace_id}, ${owner.principal.id}, ${grantee.principal.id}, ${sendEmail.key}, 'gmail', ${account}, ${meeting}, '{}', UTC_TIMESTAMP(6))`;
    return id;
  });

const search = (access: AccessScope, input: { intent: string; app?: string; limit?: number }) =>
  searchIntegrationActions(access, Schema.decodeUnknownSync(SearchIntegrationActionsInput)(input));

const providerCalls = (fake: PipedreamFixture, operation: string) => fake.calls.filter(call => call.operation === operation);

/** One migrated database for this file; every test seeds its own workspaces, so tests stay isolated. */
let database: TestDatabase & { drop: () => Promise<void> };
beforeAll(async () => {
  database = await createTestDatabase();
  await Effect.runPromise(Effect.provide(migrate(loadMigrations()), dbLayer(database.mysql)));
});
afterAll(() => database?.drop());

/** Runs `use` against the migrated database with the fixture catalog. */
const scenario = <A, E>(catalog: ReadonlyArray<FixtureAction>, use: (fake: PipedreamFixture) => Effect.Effect<A, E, SqlClient.SqlClient | PipedreamClient>) => {
  const fake = fixturePipedream(catalog);
  return use(fake).pipe(Effect.provide(fake.layer), Effect.provide(dbLayer(database.mysql)));
};

describe('integration discovery', () => {
  it.effect('keeps a 10,000-action catalog server-side behind three fixed, bounded gateways', () =>
    scenario([...syntheticCatalog(10_000), ...baseCatalog], fake =>
      Effect.gen(function*() {
        const gatewaySchemas = () => JSON.stringify([JSONSchema.make(SearchIntegrationActionsInput), JSONSchema.make(GetIntegrationActionInput), JSONSchema.make(RequestActionInput)]);
        const before = gatewaySchemas();
        const [owner] = yield* seedWorkspace('Catalog team');
        yield* connect(owner!, 'app_7');
        yield* connect(owner!, 'gmail');

        const defaults = yield* search(owner!, { intent: 'create record' });
        expect(defaults.matches.length).toBe(3);
        const widest = yield* search(owner!, { intent: 'record send email', limit: 5 });
        expect(widest.matches.length).toBe(5);
        for (const match of widest.matches) expect(Object.keys(match).sort()).toEqual(['action_key', 'app', 'connection', 'effect', 'purpose']);
        expect(bytesOf(widest)).toBeLessThan(1_500);
        expect(Either.isLeft(Schema.decodeUnknownEither(SearchIntegrationActionsInput)({ intent: 'record', limit: 6 }))).toBe(true);
        // Default search only touches the caller's connected apps.
        const searchedApps = fake.calls.flatMap(call => (call.operation === 'searchActions' ? [call.request.app] : []));
        expect(new Set(searchedApps)).toEqual(new Set(['app_7', 'gmail']));

        const inspected = yield* getIntegrationAction(owner!, { action_key: sendEmail.key });
        expect(inspected.fields.map(field => field.name)).toEqual(['gmail', 'to', 'subject', 'body']);
        expect(JSON.stringify(inspected)).not.toMatch(/app_\d+-op-/);
        expect(providerCalls(fake, 'getAction').map(call => call.request)).toEqual([sendEmail.key]);
        expect(gatewaySchemas()).toBe(before);
        expect(before).not.toMatch(/app_\d+-op-|gmail/);
      }),
    ),
  );

  it.effect('binds accounts to their owner, workspace, grants and meetings', () =>
    scenario(baseCatalog, fake =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient;
        const [owner, member, agent] = yield* seedWorkspace('Team A', ['owner', 'member', 'agent']);
        const [outsider] = yield* seedWorkspace('Team B', ['owner']);
        const account = yield* connect(owner!, 'gmail');
        const outsiderAccount = yield* connect(outsider!, 'gmail');
        const gmail = { intent: 'send email', app: 'gmail' };

        expect((yield* search(owner!, gmail)).matches[0]).toMatchObject({ action_key: sendEmail.key, connection: 'connected', effect: 'send' });
        expect((yield* search(outsider!, gmail)).matches[0]?.connection).toBe('connected');
        const unpermitted = yield* search(member!, gmail);
        expect(unpermitted.matches[0]?.connection).toBe('not_permitted');
        expect(unpermitted.refinement_hint).toMatch(/Connect gmail/);
        expect((yield* search(member!, { intent: 'send email' })).matches).toEqual([]);
        expect((yield* search({ ...owner!, scopes: ['context:read'] }, gmail)).matches[0]?.connection).toBe('not_permitted');

        const crossWorkspace = yield* Effect.flip(getIntegrationAction(outsider!, { action_key: sendEmail.key, account_id: account }));
        expect(crossWorkspace._tag).toBe('NotFound');
        const execute = (access: AccessScope, account_id: IntegrationAccountId) =>
          executeIntegrationAction({ access, account_id, action_key: sendEmail.key, version: '0.1.0', configuration_ref: 'unused', arguments: {}, provider_idempotency_key: null });
        for (const [access, id] of [[outsider!, account], [member!, account], [owner!, outsiderAccount]] as const) {
          const refused = yield* Effect.flip(execute(access, id));
          expect(refused).toMatchObject({ _tag: 'IntegrationFailure', ambiguous: false, message: 'Integration account is not available to this principal' });
        }

        const grantId = yield* grant(owner!, agent!, account);
        const granted = yield* getIntegrationAction(agent!, { action_key: sendEmail.key });
        expect(granted.missing).toEqual(['to', 'subject']);
        yield* sql`UPDATE action_grants SET revoked_at = UTC_TIMESTAMP(6) WHERE id = ${grantId}`;
        expect((yield* getIntegrationAction(agent!, { action_key: sendEmail.key })).missing).toEqual(['gmail', 'to', 'subject']);

        const meeting = MeetingId.make(randomUUID());
        yield* sql`INSERT INTO meetings (id, workspace_id, state, timezone, started_at, processing, created_at, updated_at)
          VALUES (${meeting}, ${owner!.workspace_id}, 'active', 'UTC', UTC_TIMESTAMP(6), '{}', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
        yield* grant(owner!, agent!, account, meeting);
        expect((yield* search({ ...agent!, meetings: { kind: 'allowlist', meeting_ids: [] } }, gmail)).matches[0]?.connection).toBe('not_permitted');
        expect((yield* search({ ...agent!, meetings: { kind: 'allowlist', meeting_ids: [meeting] } }, gmail)).matches[0]?.connection).toBe('connected');

        // Two usable accounts: never pick one silently; offer both as the app field's options.
        const second = yield* connect(owner!, 'gmail');
        const ambiguous = yield* getIntegrationAction(owner!, { action_key: sendEmail.key, field: 'gmail' });
        expect(ambiguous.missing).toContain('gmail');
        expect(ambiguous.options?.values.map(option => option.value)).toEqual([account, second]);
        const chosen = yield* getIntegrationAction(owner!, { action_key: sendEmail.key, account_id: second });
        expect(chosen.missing).toEqual(['to', 'subject']);
        expect(providerCalls(fake, 'runAction')).toEqual([]);
      }),
    ),
  );

  it.effect('reports missing connections without enabling execution', () =>
    scenario(baseCatalog, fake =>
      Effect.gen(function*() {
        const [owner] = yield* seedWorkspace('Unconnected');
        const nothing = yield* search(owner!, { intent: 'send email' });
        expect(nothing).toEqual({ matches: [], refinement_hint: expect.stringMatching(/No connected integration/) });
        expect(fake.calls).toEqual([]);
        const named = yield* search(owner!, { intent: 'send email', app: 'gmail' });
        expect(named.matches[0]?.connection).toBe('not_connected');
        expect(named.refinement_hint).toMatch(/Connect gmail/);
        expect((yield* search(owner!, { intent: 'zzz', app: 'gmail' })).refinement_hint).toMatch(/No matching action/);

        const inspected = yield* getIntegrationAction(owner!, { action_key: sendEmail.key });
        expect(inspected).toMatchObject({ missing: ['gmail', 'to', 'subject'], complete: false, options: null });
        const noAccount = yield* Effect.flip(getIntegrationAction(owner!, { action_key: postMessage.key, field: 'channel' }));
        expect(noAccount).toMatchObject({ _tag: 'NotFound', message: 'Select an account before listing channel options' });
        expect((yield* Effect.flip(getIntegrationAction(owner!, { action_key: 'gone-action' })))._tag).toBe('NotFound');
        const run = executeIntegrationAction({
          access: owner!,
          account_id: IntegrationAccountId.make(randomUUID()),
          action_key: sendEmail.key,
          version: '0.1.0',
          configuration_ref: inspected.configuration_ref,
          arguments: { to: ['a@example.com'], subject: 'Hi' },
          provider_idempotency_key: 'key-1',
        });
        expect((yield* Effect.flip(run)).ambiguous).toBe(false);
        expect(providerCalls(fake, 'runAction')).toEqual([]);
      }),
    ),
  );

  it.effect('distinguishes retryable, permanent and ambiguous provider failures', () =>
    scenario(baseCatalog, fake =>
      Effect.gen(function*() {
        const [owner] = yield* seedWorkspace('Failures');
        const account = yield* connect(owner!, 'gmail');
        fake.failNext('searchActions', new IntegrationFailure({ message: 'rate limited', status: 429, retryable: true, ambiguous: false }));
        expect(yield* Effect.flip(search(owner!, { intent: 'send' }))).toMatchObject({ _tag: 'Unavailable', retryable: true, message: 'rate limited' });
        fake.failNext('getAction', new IntegrationFailure({ message: 'bad token', status: 401, retryable: false, ambiguous: false }));
        expect(yield* Effect.flip(getIntegrationAction(owner!, { action_key: sendEmail.key }))).toMatchObject({ _tag: 'Unavailable', retryable: false });

        const { configuration_ref } = yield* getIntegrationAction(owner!, { action_key: sendEmail.key });
        fake.failNext('runAction', new IntegrationFailure({ message: 'timed out after submit', status: null, retryable: true, ambiguous: true }));
        const run = executeIntegrationAction({
          access: owner!,
          account_id: account,
          action_key: sendEmail.key,
          version: '0.1.0',
          configuration_ref,
          arguments: { to: ['a@example.com'], subject: 'Hi' },
          provider_idempotency_key: 'key-1',
        });
        expect(yield* Effect.flip(run)).toMatchObject({ _tag: 'IntegrationFailure', ambiguous: true });
        expect(providerCalls(fake, 'runAction')).toHaveLength(1);
      }),
    ),
  );
});

describe('integration configuration', () => {
  it.effect('resolves dynamic schemas and refuses stale or invalid configuration before execution', () =>
    scenario(baseCatalog, fake =>
      Effect.gen(function*() {
        const [owner] = yield* seedWorkspace('Sheets');
        const account = yield* connect(owner!, 'google_sheets');
        const provisionId = `apn_${account.slice(0, 8)}`;
        const initial = yield* getIntegrationAction(owner!, { action_key: addRow.key });
        expect(initial).toMatchObject({ missing: ['sheetId'], complete: false });
        expect(providerCalls(fake, 'reloadProps')).toEqual([]);

        const sheetA = yield* getIntegrationAction(owner!, { action_key: addRow.key, configuration: { sheetId: 'sheet-a' } });
        expect(sheetA.fields.map(field => field.name)).toEqual(['google_sheets', 'sheetId', 'col_a']);
        expect(sheetA.missing).toEqual(['col_a']);
        expect(sheetA.configuration_ref).not.toBe(initial.configuration_ref);
        expect(providerCalls(fake, 'reloadProps')[0]?.request).toMatchObject({ external_user_id: `ext-${owner!.principal.id}`, configured_props: { google_sheets: { authProvisionId: provisionId } } });

        const execute = (access: AccessScope, args: Record<string, unknown>, version = '0.1.0', configuration_ref = sheetA.configuration_ref) =>
          executeIntegrationAction({ access, account_id: account, action_key: addRow.key, version, configuration_ref, arguments: args, provider_idempotency_key: 'idem-1' });
        const failure = (effect: Effect.Effect<unknown, IntegrationFailure, SqlClient.SqlClient | PipedreamClient>) => Effect.map(Effect.flip(effect), error => error.message);

        expect(yield* failure(execute(owner!, { sheetId: 'sheet-b', col_b: 1 }))).toMatch(/configuration is stale/);
        expect(yield* failure(execute(owner!, { sheetId: 'sheet-a', col_a: 5 }))).toBe('Invalid arguments: col_a must be string');
        expect(yield* failure(execute(owner!, { sheetId: 'sheet-a' }))).toBe('Invalid arguments: col_a is required');
        expect(yield* failure(execute(owner!, { sheetId: 'sheet-a', col_a: 'x', extra: true }))).toBe('Invalid arguments: unknown field extra');
        expect(providerCalls(fake, 'runAction')).toEqual([]);

        // Model-supplied account authority is ignored; the stored account is used.
        const done = yield* execute(owner!, { sheetId: 'sheet-a', col_a: 'x', google_sheets: { authProvisionId: 'apn_evil' } });
        expect(done.artifact).toBeNull();
        expect(done.receipt).toMatchObject({ provider: 'pipedream', action_key: addRow.key, version: '0.1.0', account_id: account, provider_idempotency_key: 'idem-1' });
        expect(providerCalls(fake, 'runAction')[0]?.request).toEqual({
          id: addRow.key,
          version: '0.1.0',
          external_user_id: `ext-${owner!.principal.id}`,
          configured_props: { sheetId: 'sheet-a', col_a: 'x', google_sheets: { authProvisionId: provisionId } },
          dynamic_props_id: 'dyn_google_sheets_sheetId_col_a',
        });

        fake.actions.set(addRow.key, { ...addRow, version: '0.2.0' });
        expect(yield* failure(execute(owner!, { sheetId: 'sheet-a', col_a: 'x' }))).toMatch(/changed since it was inspected/);
        expect(providerCalls(fake, 'runAction')).toHaveLength(1);
      }),
    ),
  );

  it.effect('keeps a queued action authorized across unrelated permission changes, and blocks it once its grant or grantee membership goes', () =>
    scenario(baseCatalog, fake =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient;
        const [owner, agent] = yield* seedWorkspace('Queued', ['owner', 'agent']);
        yield* seedCredential(owner!, agent!);
        const account = yield* connect(owner!, 'gmail');
        const current = () => resolveAccess({ workspace_id: agent!.workspace_id, principal_id: agent!.principal.id });
        // Requested exactly as an agent would: inspect, then request with the returned ref.
        const queue = (idempotency_key: string) =>
          Effect.gen(function*() {
            const access = yield* current();
            const { version, configuration_ref } = yield* getIntegrationAction(access, { action_key: sendEmail.key });
            const queued = yield* requestAction(access, { action_key: sendEmail.key, version, configuration_ref, arguments: { to: ['a@example.com'], subject: 'Hi' }, meeting_id: null, idempotency_key });
            return { id: queued.action_id, revision: access.permission_revision };
          });
        const run = (action_id: string) =>
          Effect.flatMap(queuedJob(agent!.workspace_id, 'action.execute', action_id), executeAction).pipe(Effect.zipRight(actionRow(agent!.workspace_id, action_id as never)));

        const firstGrant = yield* grant(owner!, agent!, account);
        const unaffected = yield* queue('unrelated-changes');
        const meeting = yield* seedMeeting(owner!.workspace_id);
        // A new member who is given one meeting: each change bumps the workspace permission revision.
        const person = randomUUID();
        const bump = sql`UPDATE workspaces SET permission_revision = permission_revision + 1 WHERE id = ${owner!.workspace_id}`;
        yield* sql`INSERT INTO principals (id, kind, display_name, created_at) VALUES (${person}, 'human', 'New member', UTC_TIMESTAMP(6))`;
        yield* sql`INSERT INTO workspace_members (workspace_id, principal_id, role, created_at) VALUES (${owner!.workspace_id}, ${person}, 'member', UTC_TIMESTAMP(6))`.pipe(Effect.zipRight(bump));
        yield* sql`INSERT INTO meeting_access (workspace_id, meeting_id, principal_id, access, granted_by, created_at)
          VALUES (${owner!.workspace_id}, ${meeting}, ${person}, 'read', ${owner!.principal.id}, UTC_TIMESTAMP(6))`.pipe(Effect.zipRight(bump));
        expect((yield* current()).permission_revision).toBeGreaterThan(unaffected.revision);
        expect(yield* run(unaffected.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
        expect(providerCalls(fake, 'runAction')).toHaveLength(1);

        const revoked = yield* queue('grant-revoked');
        yield* revokeActionGrant(owner!, firstGrant as never);
        expect(yield* run(revoked.id)).toMatchObject({ state: 'cancelled', attempts: 0, last_error: { code: 'forbidden' } });

        yield* grant(owner!, agent!, account);
        const removed = yield* queue('member-removed');
        yield* sql`UPDATE workspace_members SET revoked_at = UTC_TIMESTAMP(6) WHERE workspace_id = ${agent!.workspace_id} AND principal_id = ${agent!.principal.id}`;
        yield* sql`UPDATE workspaces SET permission_revision = permission_revision + 1 WHERE id = ${agent!.workspace_id}`;
        expect(yield* run(removed.id)).toMatchObject({ state: 'cancelled', attempts: 0, last_error: { code: 'forbidden' } });
        expect(providerCalls(fake, 'runAction')).toHaveLength(1);
      }),
    ),
  );

  it.effect('pages account-bound remote options across upstream pages with bound cursors', () =>
    scenario(baseCatalog, fake =>
      Effect.gen(function*() {
        const [owner] = yield* seedWorkspace('Slack');
        const account = yield* connect(owner!, 'slack');
        const seen: Array<unknown> = [];
        let cursor: string | undefined;
        let first: string | null = null;
        do {
          const page = yield* getIntegrationAction(owner!, { action_key: postMessage.key, field: 'channel', ...(cursor ? { options_cursor: cursor } : {}) });
          expect(page.options!.values.length).toBeLessThanOrEqual(engineeringDefaults.pipedream.optionsPageSize);
          seen.push(...page.options!.values.map(option => option.value));
          cursor = page.options!.next_cursor ?? undefined;
          first ??= cursor ?? null;
        } while (cursor);
        expect(seen).toEqual(channels.map(channel => channel.value));
        const upstream = fake.calls.flatMap(call => (call.operation === 'configureProp' ? [call.request] : []));
        expect(new Set(upstream.map(request => request.page))).toEqual(new Set([0, 1, 2]));
        expect(upstream[0]).toMatchObject({ external_user_id: `ext-${owner!.principal.id}`, configured_props: { slack: { authProvisionId: `apn_${account.slice(0, 8)}` } } });

        const stale = (access: AccessScope, field: string, options_cursor: string) => Effect.flip(getIntegrationAction(access, { action_key: postMessage.key, field, options_cursor }));
        // Unrelated permission changes leave a cursor valid; the caller's accounts are re-read on every page.
        yield* getIntegrationAction({ ...owner!, permission_revision: owner!.permission_revision + 5 }, { action_key: postMessage.key, field: 'channel', options_cursor: first! });
        expect((yield* stale(owner!, 'text', first!)).message).toMatch(/cursor is stale/);
        expect((yield* stale(owner!, 'channel', 'not-a-cursor')).message).toMatch(/cursor is stale/);
        expect((yield* Effect.flip(getIntegrationAction(owner!, { action_key: postMessage.key, field: 'text' }))).message).toBe('text has no selectable options');
      }),
    ),
  );

  it.effect('keeps schemas, options and results inside the output budget without silent truncation', () => {
    const longText = 'x'.repeat(300);
    const wide = action('notion', 'create-page', 'Create Page', [
      { name: 'title', type: 'string', description: longText },
      ...Array.from({ length: 400 }, (_, index) => ({ name: `optional_${index}`, type: 'string', optional: true, description: longText })),
    ]);
    const huge = action('notion', 'bulk', 'Bulk', Array.from({ length: 200 }, (_, index) => ({ name: `required_${index}`, type: 'string', description: longText })));
    const wideOptions = action('notion', 'pick', 'Pick', [{ name: 'page', type: 'string', remoteOptions: true }, { name: 'giant', type: 'string', remoteOptions: true }], {
      options: {
        page: Array.from({ length: 30 }, (_, index) => ({ label: `${index}:${'p'.repeat(2_000)}`, value: index })),
        giant: [{ label: 'g'.repeat(budget), value: 0 }],
      },
    });
    const bigResult = action('notion', 'export', 'Export', [], { ret: 'r'.repeat(budget + 1) });
    return scenario([...baseCatalog, wide, huge, wideOptions, bigResult], () =>
      Effect.gen(function*() {
        const [owner] = yield* seedWorkspace('Budget');
        const account = yield* connect(owner!, 'notion');

        const trimmed = yield* getIntegrationAction(owner!, { action_key: wide.key });
        expect(bytesOf(trimmed)).toBeLessThanOrEqual(budget);
        expect(trimmed.fields.map(field => field.name)).toEqual(['notion', 'title']);
        expect(trimmed.fields[1]?.description).toBe(longText);
        expect(trimmed).toMatchObject({ missing: ['title'], complete: false });

        const required = yield* getIntegrationAction(owner!, { action_key: huge.key });
        expect(bytesOf(required)).toBeLessThanOrEqual(budget);
        expect(required).toMatchObject({ fields: [], complete: false });
        expect(required.missing).toHaveLength(200);

        const values: Array<unknown> = [];
        let cursor: string | undefined;
        do {
          const page = yield* getIntegrationAction(owner!, { action_key: wideOptions.key, field: 'page', ...(cursor ? { options_cursor: cursor } : {}) });
          expect(bytesOf(page)).toBeLessThanOrEqual(budget);
          expect(page.options!.values.length).toBeLessThan(engineeringDefaults.pipedream.optionsPageSize);
          values.push(...page.options!.values.map(option => option.value));
          cursor = page.options!.next_cursor ?? undefined;
        } while (cursor);
        expect(values).toEqual(Array.from({ length: 30 }, (_, index) => index));
        const giant = yield* Effect.flip(getIntegrationAction(owner!, { action_key: wideOptions.key, field: 'giant' }));
        expect(giant).toMatchObject({ _tag: 'Unavailable', retryable: false, message: 'An option of giant exceeds the output budget' });

        const { configuration_ref } = yield* getIntegrationAction(owner!, { action_key: bigResult.key });
        const exported = yield* executeIntegrationAction({ access: owner!, account_id: account, action_key: bigResult.key, version: '0.1.0', configuration_ref, arguments: {}, provider_idempotency_key: null });
        expect(exported.receipt).toMatchObject({ result: null, result_sha256: createHash('sha256').update(exported.artifact!).digest('hex') });
        expect(bytesOf(exported.receipt)).toBeLessThan(1_000);
        expect(JSON.parse(new TextDecoder().decode(exported.artifact!))).toEqual({ exports: { $summary: `ran ${bigResult.key}` }, ret: bigResult.ret });
      }),
    );
  });
});

describe('Google Drive uploads', () => {
  it.effect('sends raw bytes through the proxy and verifies the stored copy', () =>
    scenario(baseCatalog, fake =>
      Effect.gen(function*() {
        const [owner] = yield* seedWorkspace('Drive');
        const drive = yield* connect(owner!, 'google_drive');
        const mail = yield* connect(owner!, 'gmail');
        const bytes = Uint8Array.from({ length: 1_024 }, (_, index) => index % 256);
        let stored = bytes;
        fake.respondToProxy(() => ({ id: 'file-1', name: 'notes.bin', size: String(stored.byteLength), md5Checksum: md5(stored) }));

        const { receipt } = yield* uploadDriveFile(owner!, { account_id: drive, name: 'notes.bin', mime_type: 'application/octet-stream', bytes, parent_id: 'folder-1' });
        expect(receipt).toEqual({
          provider: 'pipedream',
          operation: 'google_drive.upload',
          account_id: drive,
          file_id: 'file-1',
          name: 'notes.bin',
          byte_length: 1_024,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
        const [sent] = fake.calls.flatMap(call => (call.operation === 'proxy' ? [call.request] : []));
        expect(sent!).toMatchObject({ account_id: `apn_${drive.slice(0, 8)}`, external_user_id: `ext-${owner!.principal.id}`, method: 'POST' });
        expect(sent!.url).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=multipart/);
        const boundary = /boundary=(.+)$/.exec(sent!.headers['content-type']!)![1]!;
        const body = Buffer.from(sent!.body!);
        const metadataEnd = body.indexOf('\r\n\r\n', body.indexOf('application/octet-stream')) + 4;
        expect(body.subarray(metadataEnd, metadataEnd + bytes.length).equals(Buffer.from(bytes))).toBe(true);
        expect(body.subarray(metadataEnd + bytes.length).toString()).toBe(`\r\n--${boundary}--`);
        expect(body.toString()).toContain('{"name":"notes.bin","mimeType":"application/octet-stream","parents":["folder-1"]}');

        stored = bytes.subarray(1);
        const corrupted = yield* Effect.flip(uploadDriveFile(owner!, { account_id: drive, name: 'notes.bin', mime_type: 'application/octet-stream', bytes }));
        expect(corrupted).toMatchObject({ ambiguous: false, message: 'Drive stored different bytes than were sent (file file-1)' });
        expect((yield* Effect.flip(uploadDriveFile(owner!, { account_id: mail, name: 'a', mime_type: 'text/plain', bytes }))).message).toMatch(/not a Google Drive account/);
        expect((yield* Effect.flip(uploadDriveFile(owner!, { account_id: drive, name: 'a', mime_type: 'text/plain\r\nX: 1', bytes }))).message).toBe('Invalid MIME type');
        fake.failNext('proxy', new IntegrationFailure({ message: 'Pipedream responded 504', status: 504, retryable: true, ambiguous: true }));
        expect((yield* Effect.flip(uploadDriveFile(owner!, { account_id: drive, name: 'a', mime_type: 'text/plain', bytes }))).ambiguous).toBe(true);
        expect(providerCalls(fake, 'proxy')).toHaveLength(3);
      }),
    ),
  );
});

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: Buffer;
}

/** Local stand-in for api.pipedream.com: records requests and answers from `respond`. */
const fakeConnectServer = (respond: (request: Recorded) => { status: number; body: unknown }) =>
  Effect.gen(function* () {
    const requests: Array<Recorded> = [];
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const recorded = { method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(chunks) };
        requests.push(recorded);
        const answer = respond(recorded);
        response.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
      });
    });
    yield* Effect.acquireRelease(
      Effect.async<void>(resume => {
        server.listen(0, '127.0.0.1', () => resume(Effect.void));
      }),
      () => Effect.sync(() => server.close()),
    );
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, requests };
  });

describe('Pipedream Connect client', () => {
  it.scoped('authenticates once, forwards raw proxy bytes and classifies upstream failures', () =>
    Effect.gen(function*() {
      let proxyStatus = 200;
      const connect = yield* fakeConnectServer(request => {
        if (request.url === '/v1/oauth/token') return { status: 200, body: { access_token: 'token-1', expires_in: 3_600 } };
        if (request.url.startsWith('/v1/connect/proj/actions/missing')) return { status: 404, body: { error: 'not found' } };
        if (request.url === '/v1/connect/proj/actions/run') return { status: 200, body: { os: [{ k: 'error', err: { message: 'boom' }, msg: 'boom' }] } };
        if (request.url.startsWith('/v1/connect/proj/proxy/')) return { status: proxyStatus, body: { id: 'f' } };
        return { status: 500, body: {} };
      });
      const config = { apiUrl: connect.url, environment: 'development' as const, credentials: Option.some({ projectId: 'proj', clientId: 'cid', clientSecret: Redacted.make('secret') }) };
      const client = makePipedreamClient(config, 30_000);

      expect(yield* client.getAction('missing')).toBeNull();
      const bytes = Uint8Array.from([0, 255, 13, 10, 128, 7]);
      const target = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
      const proxy = (method: 'GET' | 'POST') =>
        client.proxy({ external_user_id: 'ext-1', account_id: 'apn_1', method, url: target, headers: { 'content-type': 'multipart/related; boundary=b' }, ...(method === 'POST' ? { body: bytes } : {}) });
      expect(JSON.parse(new TextDecoder().decode(yield* proxy('POST')))).toEqual({ id: 'f' });

      const [token, lookup, upload] = connect.requests;
      expect(JSON.parse(token!.body.toString())).toEqual({ grant_type: 'client_credentials', client_id: 'cid', client_secret: 'secret' });
      expect(connect.requests.filter(request => request.url === '/v1/oauth/token')).toHaveLength(1);
      expect(lookup!.headers).toMatchObject({ authorization: 'Bearer token-1', 'x-pd-environment': 'development' });
      const uploadUrl = new URL(upload!.url, connect.url);
      expect(Buffer.from(uploadUrl.pathname.split('/').at(-1)!, 'base64url').toString()).toBe(target);
      expect(Object.fromEntries(uploadUrl.searchParams)).toEqual({ external_user_id: 'ext-1', account_id: 'apn_1' });
      expect(upload!.headers['x-pd-proxy-content-type']).toBe('multipart/related; boundary=b');
      expect(upload!.body.equals(Buffer.from(bytes))).toBe(true);

      const runFailure = yield* Effect.flip(client.runAction({ id: 'a', version: '1.0.0', external_user_id: 'ext-1', configured_props: {} }));
      expect(runFailure).toMatchObject({ ambiguous: true, message: 'Action reported an error: boom' });
      proxyStatus = 504;
      expect(yield* Effect.flip(proxy('POST'))).toMatchObject({ status: 504, retryable: true, ambiguous: true });
      expect(yield* Effect.flip(proxy('GET'))).toMatchObject({ status: 504, retryable: true, ambiguous: false });
      proxyStatus = 400;
      expect(yield* Effect.flip(proxy('POST'))).toMatchObject({ status: 400, retryable: false, ambiguous: false });

      const refused = makePipedreamClient({ ...config, apiUrl: 'http://127.0.0.1:1' }, 30_000);
      expect(yield* Effect.flip(refused.proxy({ external_user_id: 'e', account_id: 'a', method: 'POST', url: target, headers: {}, body: bytes }))).toMatchObject({ status: null, ambiguous: false, retryable: true });
      const unconfigured = makePipedreamClient({ ...config, credentials: Option.none() }, 30_000);
      expect(yield* Effect.flip(unconfigured.searchActions({ q: 'x', app: 'gmail', limit: 3 }))).toMatchObject({ message: 'Pipedream is not configured', retryable: false });
    }),
  );

  it.scoped('lists every Connect account across pages', () =>
    Effect.gen(function*() {
      const accounts = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ id: `apn_${prefix}${index}`, app: { name_slug: 'gmail' } }));
      const connect = yield* fakeConnectServer(request => {
        if (request.url === '/v1/oauth/token') return { status: 200, body: { access_token: 'token-1', expires_in: 3_600 } };
        const after = new URL(request.url, 'http://fake').searchParams.get('after');
        if (after === null) return { status: 200, body: { data: accounts('a', 100), page_info: { end_cursor: 'c1' } } };
        if (after === 'c1') return { status: 200, body: { data: accounts('b', 2), page_info: { end_cursor: 'c2' } } };
        return { status: 500, body: {} };
      });
      const client = makePipedreamClient(
        { apiUrl: connect.url, environment: 'development', credentials: Option.some({ projectId: 'proj', clientId: 'cid', clientSecret: Redacted.make('secret') }) },
        30_000,
      );
      const listed = yield* client.listAccounts('ext-1');
      expect(listed).toHaveLength(102);
      expect(listed.at(-1)).toEqual({ id: 'apn_b1', app: 'gmail', dead: false });
      expect(connect.requests.filter(request => request.url.includes('/accounts?')).map(request => new URL(request.url, connect.url).searchParams.get('after'))).toEqual([null, 'c1']);
    }),
  );
});

describe('integrations HTTP API', () => {
  it.scoped('serves discovery for the authenticated caller and reports an unconfigured provider as unavailable', () =>
    Effect.gen(function*() {
      const [owner] = yield* Effect.provide(seedWorkspace('HTTP'), dbLayer(database.mysql));
      const auth = Layer.succeed(Authenticator, {
        authenticate: request => (request.headers.authorization === 'Bearer fixture' ? Effect.succeed(owner!) : Effect.fail(new Unauthenticated({ message: 'no credentials' }))),
      });
      const context = yield* Layer.build(serverLayer({ apiPort: 0, mysql: database.mysql }, auth));
      const address = Context.get(context, HttpServer.HttpServer).address;
      const base = `http://127.0.0.1:${address._tag === 'TcpAddress' ? address.port : 0}/api/v1/integrations/actions`;
      const call = (path: string, init: RequestInit = {}) =>
        Effect.promise(async () => {
          const response = await fetch(`${base}${path}`, { ...init, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' } });
          return { status: response.status, body: (await response.json()) as Record<string, unknown> };
        });

      expect(yield* call('?intent=send%20email')).toEqual({ status: 200, body: { matches: [], refinement_hint: expect.stringMatching(/No connected integration/) } });
      const accounts = yield* Effect.promise(() => fetch(base.replace(/actions$/, 'accounts'), { headers: { authorization: 'Bearer fixture' } }).then(response => response.json()));
      expect(accounts).toEqual({ configured: false, accounts: [] });
      expect(yield* call('?intent=send&app=gmail')).toEqual({ status: 503, body: expect.objectContaining({ code: 'unavailable', message: 'Pipedream is not configured', retryable: false }) });
      expect((yield* call('?intent=send&limit=6')).status).toBe(400);
      expect((yield* call('/gmail-send-email/schema', { method: 'POST', body: '{}' })).status).toBe(503);
      const anonymous = yield* Effect.promise(() => fetch(`${base}?intent=x`));
      expect(anonymous.status).toBe(401);
    }),
  );
});

describe('integration connect flow', () => {
  it.scoped('issues a Connect Link for the session principal only, syncs accounts idempotently and disconnects them', () =>
    Effect.gen(function*() {
      const db = dbLayer(database.mysql);
      const [owner, member] = yield* Effect.provide(seedWorkspace('Connect', ['owner', 'member']), db);
      const session = yield* Effect.provide(openSession({ workspace_id: owner!.workspace_id, principal_id: owner!.principal.id }), db);
      const external = `${owner!.workspace_id}.${owner!.principal.id}`;
      let connected = [{ id: 'apn_mail', app: { name_slug: 'gmail', name: 'Gmail' }, dead: false }];
      const pipedream = yield* fakeConnectServer(request => {
        if (request.url === '/v1/oauth/token') return { status: 200, body: { access_token: 'token-1', expires_in: 3_600 } };
        if (request.url === '/v1/connect/proj_test/tokens') {
          return { status: 200, body: { token: 'ctok_1', expires_at: '2026-10-10T00:15:00Z', connect_link_url: 'https://pipedream.com/_static/connect.html?token=ctok_1&connectLink=true' } };
        }
        if (request.url.startsWith('/v1/connect/proj_test/accounts?')) return { status: 200, body: { data: connected, page_info: { count: connected.length } } };
        if (request.method === 'DELETE' && request.url === '/v1/connect/proj_test/accounts/apn_mail') return { status: 204, body: undefined };
        return { status: 500, body: {} };
      });
      const env = new Map([['PIPEDREAM_API_URL', pipedream.url], ['PIPEDREAM_PROJECT_ID', 'proj_test'], ['PIPEDREAM_CLIENT_ID', 'cid'], ['PIPEDREAM_CLIENT_SECRET', 'client-secret']]);
      const context = yield* Layer.build(serverLayer({ apiPort: 0, mysql: database.mysql })).pipe(
        Effect.withConfigProvider(ConfigProvider.fromMap(env).pipe(ConfigProvider.orElse(ConfigProvider.fromEnv))),
      );
      const address = Context.get(context, HttpServer.HttpServer).address;
      const base = `http://127.0.0.1:${address._tag === 'TcpAddress' ? address.port : 0}/api/v1/integrations`;
      const cookie = `sanctum_session=${session.token}`;
      const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
        Effect.promise(async () => {
          const response = await fetch(`${base}${path}`, {
            method: init.method ?? 'POST',
            headers: { 'content-type': 'application/json', ...init.headers },
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          });
          const text = await response.text();
          return { status: response.status, body: text ? JSON.parse(text) : null, text };
        });
      const signedIn = { cookie, 'x-csrf-token': session.csrf_token };

      // The token endpoint needs a session and its CSRF token; the external user comes from the session, never the body.
      expect((yield* call('/connect', { body: { app: 'gmail' } })).status).toBe(401);
      expect((yield* call('/connect', { headers: { cookie }, body: { app: 'gmail' } })).status).toBe(403);
      expect((yield* call('/connect', { headers: { cookie, 'x-csrf-token': 'wrong' }, body: { app: 'gmail' } })).status).toBe(403);
      expect(pipedream.requests.filter(request => request.url.endsWith('/tokens'))).toHaveLength(0);
      const link = yield* call('/connect', { headers: signedIn, body: { app: 'gmail', external_user_id: 'someone-else' } });
      expect(link.status).toBe(200);
      expect(link.body).toEqual({ url: 'https://pipedream.com/_static/connect.html?token=ctok_1&connectLink=true&app=gmail' });
      expect(link.text).not.toContain('client-secret');
      const tokenRequest = pipedream.requests.find(request => request.url.endsWith('/tokens'))!;
      expect(JSON.parse(tokenRequest.body.toString())).toEqual({ external_user_id: external, expires_in: 900, scope: 'connect:accounts:write connect:apps:*' });
      expect(tokenRequest.headers).toMatchObject({ authorization: 'Bearer token-1', 'x-pd-environment': 'development' });
      expect((yield* call('/connect', { headers: signedIn, body: { app: 'Not An App' } })).status).toBe(400);

      // Sync stores the account once; a repeat leaves the same row untouched; nothing is granted.
      expect((yield* call('/accounts/sync', { headers: { cookie } })).status).toBe(403);
      const first = yield* call('/accounts/sync', { headers: signedIn });
      expect(first.body).toEqual({ configured: true, accounts: [{ id: expect.any(String), app: 'gmail', grants: [] }] });
      const listed = pipedream.requests.find(request => request.url.startsWith('/v1/connect/proj_test/accounts?'))!;
      expect(new URL(listed.url, pipedream.url).searchParams.get('external_user_id')).toBe(external);
      const rows = () =>
        Effect.provide(
          Effect.flatMap(SqlClient.SqlClient, sql => sql<{ id: string; status: string; owner_principal_id: string; external_user_id: string; updated_at: Date }>`
            SELECT id, status, owner_principal_id, external_user_id, updated_at FROM integration_accounts WHERE workspace_id = ${owner!.workspace_id}`),
          db,
        );
      const stored = yield* rows();
      expect(stored).toEqual([expect.objectContaining({ status: 'active', owner_principal_id: owner!.principal.id, external_user_id: external })]);
      expect((yield* call('/accounts/sync', { headers: signedIn })).body).toEqual(first.body);
      expect(yield* rows()).toEqual(stored);
      const grants = yield* Effect.provide(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT 1 FROM action_grants WHERE workspace_id = ${owner!.workspace_id}`), db);
      expect(grants).toHaveLength(0);

      // The owner's grant shows under the account; another member sees none of the owner's accounts.
      const account = IntegrationAccountId.make(stored[0]!.id);
      yield* Effect.provide(
        createActionGrant(owner!, { grantee: member!.principal.id, action_key: sendEmail.key, account_id: account, meeting_id: null, restrictions: {}, expires_at: null }),
        db,
      );
      expect((yield* call('/accounts', { method: 'GET', headers: { cookie } })).body.accounts[0].grants).toEqual([
        { id: expect.any(String), action_key: sendEmail.key, grantee_name: 'Connect member' },
      ]);
      const memberSession = yield* Effect.provide(openSession({ workspace_id: member!.workspace_id, principal_id: member!.principal.id }), db);
      expect((yield* call('/accounts', { method: 'GET', headers: { cookie: `sanctum_session=${memberSession.token}` } })).body).toEqual({ configured: true, accounts: [] });
      expect((yield* call(`/accounts/${account}/disconnect`, { headers: { cookie: `sanctum_session=${memberSession.token}`, 'x-csrf-token': memberSession.csrf_token } })).status).toBe(404);

      // An account removed at Pipedream stops counting on the next sync; reconnecting it restores the row.
      const removed = connected;
      connected = [];
      expect((yield* call('/accounts/sync', { headers: signedIn })).body).toEqual({ configured: true, accounts: [] });
      expect((yield* rows())[0]).toMatchObject({ status: 'disconnected' });
      expect(yield* Effect.provide(activeActionGrants(member!), db)).toHaveLength(0);
      connected = removed;
      expect((yield* call('/accounts/sync', { headers: signedIn })).body.accounts).toEqual([expect.objectContaining({ id: account, app: 'gmail' })]);
      expect(yield* Effect.provide(activeActionGrants(member!), db)).toHaveLength(1);

      // Disconnect deletes the account at Pipedream, then stops listing it; its grant no longer counts.
      expect((yield* call(`/accounts/${account}/disconnect`, { headers: { cookie } })).status).toBe(403);
      expect((yield* call(`/accounts/${account}/disconnect`, { headers: signedIn })).body).toEqual({ configured: true, accounts: [] });
      expect(pipedream.requests.filter(request => request.method === 'DELETE').map(request => request.url)).toEqual(['/v1/connect/proj_test/accounts/apn_mail']);
      expect((yield* rows())[0]).toMatchObject({ status: 'disconnected' });
      expect(yield* Effect.provide(activeActionGrants(member!), db)).toHaveLength(0);
      connected = [];
      expect((yield* call('/accounts/sync', { headers: signedIn })).body).toEqual({ configured: true, accounts: [] });
    }),
  );
});
