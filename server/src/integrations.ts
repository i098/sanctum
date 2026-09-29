/**
 * The model-facing integration gateways (plan section 10): search the catalog, inspect one
 * selected action, and execute a request the actions slice has already authorized and persisted.
 * The Pipedream catalog stays server-side, connected accounts come only from MySQL (never from
 * model output), and every model-facing result is bounded by an explicit byte budget.
 */
import { createHash, randomUUID } from 'node:crypto';
import { HttpApiBuilder } from '@effect/platform';
import { SqlClient, SqlSchema } from '@effect/sql';
import {
  type AccessScope,
  CurrentAccess,
  type GetIntegrationActionInput,
  type GetIntegrationActionOutput,
  IntegrationAccountId,
  NotFound,
  SEARCH_MAX_LIMIT,
  type SearchIntegrationActionsInput,
  type SearchIntegrationActionsOutput,
  Unavailable,
} from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Effect, Layer, Schema } from 'effect';
import { engineeringDefaults, serverConfig } from './config.ts';
import { DbSafeInt } from './db.ts';
import { type ActionComponent, type ActionProp, IntegrationFailure, PipedreamClient, makePipedreamClient } from './providers/pipedream.ts';

export { IntegrationFailure };

const { outputBudgetBytes, optionsPageSize } = engineeringDefaults.pipedream;

const AccountRow = Schema.Struct({
  id: IntegrationAccountId,
  app_slug: Schema.String,
  external_user_id: Schema.String,
  provider_account_id: Schema.String,
  usable: Schema.transform(DbSafeInt, Schema.Boolean, { strict: true, decode: value => value === 1, encode: value => (value ? 1 : 0) }),
});
type Account = typeof AccountRow.Type;

/**
 * Active accounts of the caller's workspace. `usable`: the caller holds `actions:request` and either
 * owns the account or holds an active grant for it whose meeting (if any) it may access.
 */
const workspaceAccounts = (access: AccessScope, filter: { readonly app?: string; readonly id?: IntegrationAccountId }) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const principal = access.principal.id;
    const meetings = access.meetings;
    const meetingVisible =
      meetings.kind === 'accessible'
        ? sql`TRUE`
        : meetings.meeting_ids.length === 0
          ? sql`g.meeting_id IS NULL`
          : sql`(g.meeting_id IS NULL OR ${sql.in('g.meeting_id', meetings.meeting_ids)})`;
    return yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: AccountRow,
      execute: () => sql`
        SELECT a.id, a.app_slug, a.external_user_id, a.provider_account_id,
          (${access.scopes.includes('actions:request')} AND (a.owner_principal_id = ${principal} OR EXISTS (
            SELECT 1 FROM action_grants g
            WHERE g.workspace_id = a.workspace_id AND g.account_id = a.id AND g.grantee_principal_id = ${principal}
              AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > UTC_TIMESTAMP(6)) AND ${meetingVisible}
          ))) AS usable
        FROM integration_accounts a
        WHERE ${sql.and([
    sql`a.workspace_id = ${access.workspace_id}`,
    sql`a.status = 'active'`,
    ...(filter.app === undefined ? [] : [sql`a.app_slug = ${filter.app}`]),
    ...(filter.id === undefined ? [] : [sql`a.id = ${filter.id}`]),
   ])}
        ORDER BY a.created_at, a.id`,
    })(undefined);
  });

const appPropOf = (action: ActionComponent) => action.configurable_props.find(prop => prop.type === 'app');

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Required, model-visible props that still have no value. */
const missingFields = (props: ReadonlyArray<ActionProp>, configured: Readonly<Record<string, unknown>>) =>
  props.filter(prop => !prop.optional && !prop.hidden && prop.type !== 'alert' && configured[prop.name] === undefined).map(prop => prop.name);

/** Caller-supplied values plus the app prop bound to the resolved account; supplied app values are dropped. */
const configure = (action: ActionComponent, account: Account | undefined, configuration: Readonly<Record<string, unknown>>) => {
  const appName = appPropOf(action)?.name;
  const configured: Record<string, unknown> = Object.fromEntries(Object.entries(configuration).filter(([name]) => name !== appName));
  if (appName && account) configured[appName] = { authProvisionId: account.provider_account_id };
  return configured;
};

/**
 * Account-bound props for one action. `ref` names the schema the caller saw: it changes with the
 * component version, the dynamic props, the account, and the caller's permission revision.
 */
interface ResolvedSchema {
  readonly configured: Readonly<Record<string, unknown>>;
  readonly props: ReadonlyArray<ActionProp>;
  readonly dynamic_props_id: string | undefined;
  readonly ref: string;
}

const resolveSchema = (
  access: AccessScope,
  action: ActionComponent,
  account: Account | undefined,
  configuration: Readonly<Record<string, unknown>>,
): Effect.Effect<ResolvedSchema, IntegrationFailure, PipedreamClient> =>
  Effect.gen(function*() {
    const client = yield* PipedreamClient;
    const configured = configure(action, account, configuration);
    const reload = account && action.configurable_props.some(prop => prop.reloadProps && configured[prop.name] !== undefined);
    const dynamic = reload ? yield* client.reloadProps({ id: action.key, version: action.version, external_user_id: account.external_user_id, configured_props: configured }) : null;
    const props = dynamic?.props ?? action.configurable_props;
    const shape = [access.workspace_id, access.principal.id, access.permission_revision, action.key, account?.id, props.map(prop => [prop.name, prop.type, !prop.optional])];
    return { configured, props, dynamic_props_id: dynamic?.id, ref: `${action.version}:${sha256(JSON.stringify(shape)).slice(0, 32)}` };
  });

const toUnavailable = (error: { readonly message: string; readonly retryable?: boolean }) => new Unavailable({ message: error.message, retryable: error.retryable ?? true });

/**
 * At most five compact matches (no schemas). Searches the caller's usable apps unless an app is
 * named; a named app without a usable account returns a connection hint, never execution.
 */
export const searchIntegrationActions = (access: AccessScope, input: typeof SearchIntegrationActionsInput.Type) =>
  Effect.gen(function*() {
    const client = yield* PipedreamClient;
    const accounts = yield* workspaceAccounts(access, input.app === undefined ? {} : { app: input.app });
    const connection = (app: string) =>
      accounts.some(account => account.app_slug === app && account.usable) ? 'connected' : accounts.some(account => account.app_slug === app) ? 'not_permitted' : 'not_connected';
    const apps = input.app === undefined ? [...new Set(accounts.filter(account => account.usable).map(account => account.app_slug))] : [input.app];
    if (apps.length === 0) {
      return { matches: [], refinement_hint: 'No connected integration is available to you; name an app to see its actions and connection requirements.' };
    }
    const limit = Math.min(input.limit, SEARCH_MAX_LIMIT);
    const perApp = yield* Effect.forEach(apps, app => client.searchActions({ q: input.intent, app, limit }), { concurrency: 4 });
    // Pipedream returns ranked lists without scores: interleave apps by rank (stable sort).
    const ranked = perApp.flatMap((actions, index) => actions.map((action, rank) => ({ app: apps[index]!, action, rank }))).sort((a, b) => a.rank - b.rank);
    const matches = ranked.slice(0, limit).map(({ app, action }) => ({
      action_key: action.key,
      app,
      purpose: (action.description?.split('\n')[0] || action.name).slice(0, 160),
      connection: connection(app),
      effect: action.annotations?.readOnlyHint ? 'read' : action.annotations?.destructiveHint ? 'delete' : /\bsend\b/i.test(action.name) ? 'send' : 'write',
    })) satisfies (typeof SearchIntegrationActionsOutput.Type)['matches'];
    const hint =
      matches.length === 0
        ? 'No matching action; rephrase the intent or name an app.'
        : input.app !== undefined && connection(input.app) !== 'connected'
          ? `Connect ${input.app}, or ask its owner for a grant, before its actions can run.`
          : null;
    return { matches, refinement_hint: hint };
  }).pipe(Effect.catchTags({ SqlError: toUnavailable, ParseError: toUnavailable, IntegrationFailure: toUnavailable }));

type InspectOutput = typeof GetIntegrationActionOutput.Type;
type OptionsPage = { readonly options: ReadonlyArray<{ readonly label: string; readonly value: unknown }>; readonly context: unknown };

const visibleProps = (props: ReadonlyArray<ActionProp>) => props.filter(prop => !prop.hidden && prop.type !== 'alert');

/** Fields fitted into the budget: optional fields go first, then all fields (configuration required); never truncated mid-field. */
const inspectOutput = (action: ActionComponent, schema: ResolvedSchema): InspectOutput => {
  const missing = missingFields(schema.props, schema.configured);
  const output = {
    action_key: action.key,
    version: action.version,
    configuration_ref: schema.ref,
    fields: visibleProps(schema.props).map(prop => ({
      name: prop.name,
      type: prop.type,
      required: !prop.optional,
      description: prop.description ?? prop.label ?? null,
      remote_options: prop.type === 'app' || prop.remoteOptions === true,
    })),
    missing,
    options: null,
    complete: missing.length === 0,
  };
  if (size(output) <= outputBudgetBytes) return output;
  const required = { ...output, fields: output.fields.filter(field => field.required), complete: false };
  return size(required) <= outputBudgetBytes ? required : { ...required, fields: [] };
};

const OptionsCursor = Schema.parseJson(Schema.Struct({ field: Schema.String, ref: Schema.String, page: Schema.Number, offset: Schema.Number, context: Schema.Unknown }));
type OptionsCursor = typeof OptionsCursor.Type;
const encodeCursor = (cursor: OptionsCursor) => Buffer.from(Schema.encodeSync(OptionsCursor)(cursor)).toString('base64url');

/** A cursor is valid only for the field and schema it was issued for. */
const decodeCursor = (encoded: string | undefined, field: string, ref: string) =>
  (encoded === undefined
    ? Effect.succeed({ field, ref, page: 0, offset: 0, context: null })
    : Schema.decodeUnknown(OptionsCursor)(Buffer.from(encoded, 'base64url').toString())
  ).pipe(
    Effect.filterOrFail(
      cursor => cursor.field === field && cursor.ref === ref,
      () => null,
    ),
    Effect.mapError(() => new NotFound({ message: 'Options cursor is stale; request the options again without a cursor' })),
  );

/** One upstream page of options: the caller's usable accounts for the app prop, else the provider's account-bound remote options. */
const loadOptions = (action: ActionComponent, schema: ResolvedSchema, usable: ReadonlyArray<Account>, account: Account | undefined, cursor: OptionsCursor) =>
  Effect.gen(function*() {
    const prop = visibleProps(schema.props).find(candidate => candidate.name === cursor.field);
    if (prop?.type === 'app') {
      return { options: usable.map(candidate => ({ label: `${candidate.app_slug} account ${candidate.id.slice(0, 8)}`, value: candidate.id })), context: null } satisfies OptionsPage;
    }
    if (!prop?.remoteOptions) return yield* new NotFound({ message: `${cursor.field} has no selectable options` });
    if (!account) return yield* new NotFound({ message: `Select an account before listing ${cursor.field} options` });
    const client = yield* PipedreamClient;
    return yield* client.configureProp({
      id: action.key,
      version: action.version,
      external_user_id: account.external_user_id,
      configured_props: schema.configured,
      dynamic_props_id: schema.dynamic_props_id,
      prop_name: cursor.field,
      page: cursor.page,
      prev_context: cursor.context,
    });
  });

/** Adds as many of the next options as the page size and budget allow, with a cursor to the first one left out. */
const withOptions = (output: InspectOutput, page: OptionsPage, cursor: OptionsCursor) => {
  const candidates = page.options.slice(cursor.offset, cursor.offset + optionsPageSize);
  const build = (count: number) => {
    const offset = cursor.offset + count;
    const upstreamNext = page.context !== null && page.options.length > 0 ? encodeCursor({ ...cursor, page: cursor.page + 1, offset: 0, context: page.context }) : null;
    const next = offset < page.options.length ? encodeCursor({ ...cursor, offset }) : upstreamNext;
    return { ...output, options: { field: cursor.field, values: candidates.slice(0, count), next_cursor: next } };
  };
  let count = candidates.length;
  while (count > 0 && size(build(count)) > outputBudgetBytes) count -= 1;
  return count === 0 && candidates.length > 0
    ? Effect.fail(new Unavailable({ message: `An option of ${cursor.field} exceeds the output budget`, retryable: false }))
    : Effect.succeed(build(count));
};

/** The caller's usable accounts for the action's app and the selected one; never guesses between several. */
const selectAccount = (access: AccessScope, action: ActionComponent, accountId: IntegrationAccountId | undefined) =>
  Effect.gen(function*() {
    const app = appPropOf(action)?.app;
    const usable = app ? (yield* workspaceAccounts(access, { app })).filter(account => account.usable) : [];
    if (accountId === undefined) return { usable, account: usable.length === 1 ? usable[0] : undefined };
    const account = usable.find(candidate => candidate.id === accountId);
    return account ? { usable, account } : yield* new NotFound({ message: 'Integration account not found' });
  });

/**
 * One selected action's versioned requirements in the caller's account scope. Options for one
 * field are paged by cursor and filled up to the budget; nothing is silently truncated.
 */
export const getIntegrationAction = (access: AccessScope, input: typeof GetIntegrationActionInput.Type) =>
  Effect.gen(function*() {
    const client = yield* PipedreamClient;
    const action = yield* client.getAction(input.action_key);
    if (!action) return yield* new NotFound({ message: 'Integration action not found' });
    const { usable, account } = yield* selectAccount(access, action, input.account_id);
    const schema = yield* resolveSchema(access, action, account, input.configuration ?? {});
    const output = inspectOutput(action, schema);
    if (input.field === undefined) return output;
    const cursor = yield* decodeCursor(input.options_cursor, input.field, schema.ref);
    return yield* withOptions(output, yield* loadOptions(action, schema, usable, account, cursor), cursor);
  }).pipe(Effect.catchTags({ SqlError: toUnavailable, ParseError: toUnavailable, IntegrationFailure: toUnavailable }));

const rejected = (message: string) => new IntegrationFailure({ message, status: null, retryable: false, ambiguous: false });

const VALUE_CHECKS: Record<string, (value: unknown) => boolean> = {
  string: value => typeof value === 'string',
  integer: value => Number.isInteger(value),
  boolean: value => typeof value === 'boolean',
  'string[]': value => Array.isArray(value) && value.every(item => typeof item === 'string'),
  'integer[]': value => Array.isArray(value) && value.every(item => Number.isInteger(item)),
  object: value => typeof value === 'object' && value !== null && !Array.isArray(value),
};

/** Usable account by ID, or a non-ambiguous rejection. */
const usableAccount = (access: AccessScope, id: IntegrationAccountId) =>
  workspaceAccounts(access, { id }).pipe(
    Effect.flatMap(([account]) => (account?.usable ? Effect.succeed(account) : Effect.fail(rejected('Integration account is not available to this principal')))),
  );

const storeFailure = (error: { readonly message: string }) => new IntegrationFailure({ message: error.message, status: null, retryable: true, ambiguous: false });

/**
 * Executes one authorized, persisted request (the actions slice owns grants, idempotency and
 * receipts). Revalidates account access, component version, schema and final arguments first;
 * discovery is never authorization. Results over budget move to `artifact`; the receipt keeps a
 * bounded summary. Pipedream actions accept no idempotency key, so the caller's key is recorded.
 */
export const executeIntegrationAction = (input: {
  readonly access: AccessScope;
  readonly account_id: IntegrationAccountId;
  readonly action_key: string;
  readonly version: string;
  readonly configuration_ref: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly provider_idempotency_key: string | null;
}) =>
  Effect.gen(function*() {
    const client = yield* PipedreamClient;
    const account = yield* usableAccount(input.access, input.account_id);
    const action = yield* client.getAction(input.action_key);
    if (!action || action.version !== input.version) return yield* rejected('Integration action changed since it was inspected; inspect it again');
    if (appPropOf(action)?.app !== account.app_slug) return yield* rejected(`Integration account does not belong to ${input.action_key}`);
    const schema = yield* resolveSchema(input.access, action, account, input.arguments);
    if (schema.ref !== input.configuration_ref) return yield* rejected('Integration configuration is stale; inspect the action again');
    const problems = [
      ...Object.keys(schema.configured).filter(name => !schema.props.some(prop => prop.name === name)).map(name => `unknown field ${name}`),
      ...missingFields(schema.props, schema.configured).map(name => `${name} is required`),
      ...schema.props.filter(prop => schema.configured[prop.name] !== undefined && VALUE_CHECKS[prop.type]?.(schema.configured[prop.name]) === false).map(prop => `${prop.name} must be ${prop.type}`),
    ];
    // ponytail: remote-option values are validated by Pipedream at run time, not re-listed here.
    if (problems.length > 0) return yield* rejected(`Invalid arguments: ${problems.join('; ')}`);
    const result = yield* client.runAction({
      id: action.key,
      version: action.version,
      external_user_id: account.external_user_id,
      configured_props: schema.configured,
      dynamic_props_id: schema.dynamic_props_id,
    });
    const bytes = new TextEncoder().encode(JSON.stringify(result));
    const inline = bytes.byteLength <= outputBudgetBytes;
    return {
      receipt: {
        provider: 'pipedream',
        action_key: action.key,
        version: action.version,
        account_id: account.id,
        provider_idempotency_key: input.provider_idempotency_key,
        result: inline ? result : null,
        result_bytes: bytes.byteLength,
        result_sha256: sha256(bytes),
      } as Record<string, unknown>,
      artifact: inline ? null : bytes,
    };
  }).pipe(Effect.catchTags({ SqlError: storeFailure, ParseError: storeFailure }));

const DriveFile = Schema.parseJson(Schema.Struct({ id: Schema.String, name: Schema.String, size: Schema.NumberFromString, md5Checksum: Schema.String }));

const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,md5Checksum';

/**
 * Uploads raw bytes to Google Drive through the Connect proxy as one multipart request, then
 * checks Drive's size and MD5 against what was sent. Drive has no idempotency key: a lost
 * response is ambiguous and must be reconciled rather than replayed.
 */
export const uploadDriveFile = (
  access: AccessScope,
  input: { readonly account_id: IntegrationAccountId; readonly name: string; readonly mime_type: string; readonly bytes: Uint8Array; readonly parent_id?: string },
) =>
  Effect.gen(function*() {
    const client = yield* PipedreamClient;
    const account = yield* usableAccount(access, input.account_id);
    if (account.app_slug !== 'google_drive') return yield* rejected('Integration account is not a Google Drive account');
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(input.mime_type)) return yield* rejected('Invalid MIME type');
    const boundary = `sanctum-${randomUUID()}`;
    const metadata = JSON.stringify({ name: input.name, mimeType: input.mime_type, ...(input.parent_id ? { parents: [input.parent_id] } : {}) });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${input.mime_type}\r\n\r\n`),
      input.bytes,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const response = yield* client.proxy({
      external_user_id: account.external_user_id,
      account_id: account.provider_account_id,
      method: 'POST',
      url: DRIVE_UPLOAD_URL,
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body,
    });
    const file = yield* Schema.decodeUnknown(DriveFile)(new TextDecoder().decode(response)).pipe(
      Effect.mapError(() => new IntegrationFailure({ message: 'Drive accepted the upload but returned an unreadable receipt', status: null, retryable: false, ambiguous: true })),
    );
    if (file.size !== input.bytes.byteLength || file.md5Checksum !== createHash('md5').update(input.bytes).digest('hex')) {
      return yield* rejected(`Drive stored different bytes than were sent (file ${file.id})`);
    }
    return {
      receipt: { provider: 'pipedream', operation: 'google_drive.upload', account_id: account.id, file_id: file.id, name: file.name, byte_length: file.size, sha256: sha256(input.bytes) } as Record<string, unknown>,
    };
  }).pipe(Effect.catchTags({ SqlError: storeFailure, ParseError: storeFailure }));

/** `/api/v1/integrations`: the same gateway functions the MCP adapter calls. */
/** Connect client from the environment; without credentials every call fails as `Unavailable`. */
const PipedreamLive = Layer.effect(
  PipedreamClient,
  Effect.map(serverConfig, config => makePipedreamClient(config.pipedream, engineeringDefaults.pipedream.requestTimeoutMs)),
);

export const IntegrationsLive = HttpApiBuilder.group(SanctumApi, 'integrations', handlers =>
  handlers
    .handle('searchIntegrationActions', ({ urlParams }) => Effect.flatMap(CurrentAccess, access => searchIntegrationActions(access, urlParams)))
    .handle('getIntegrationAction', ({ path, payload }) => Effect.flatMap(CurrentAccess, access => getIntegrationAction(access, { ...payload, action_key: path.action_key }))),
).pipe(Layer.provide(PipedreamLive));
