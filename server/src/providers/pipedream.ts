/**
 * The one account-scoped Pipedream Connect client (plan section 10), shared by API and worker.
 * Wraps the documented Connect REST endpoints: action search, retrieval, dynamic props, remote
 * options, execution and the authenticated proxy (used for raw-byte Google Drive uploads).
 * The catalog never leaves the server; integrations.ts decides what reaches a model.
 */
import { Context, Data, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { engineeringDefaults, serverConfig, type ServerConfig } from '../config.ts';

/** Failed provider call. `ambiguous`: a write may have happened upstream; never replay it blindly. */
export class IntegrationFailure extends Data.TaggedError('IntegrationFailure')<{
  readonly message: string;
  /** Upstream HTTP status, or null when no response arrived. */
  readonly status: number | null;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
}> {}

const Prop = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  label: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  optional: Schema.optional(Schema.NullOr(Schema.Boolean)),
  hidden: Schema.optional(Schema.NullOr(Schema.Boolean)),
  remoteOptions: Schema.optional(Schema.NullOr(Schema.Boolean)),
  reloadProps: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /** App slug of an `app` prop, i.e. which connected account the action needs. */
  app: Schema.optional(Schema.NullOr(Schema.String)),
});
export type ActionProp = typeof Prop.Type;

const Component = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  version: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  configurable_props: Schema.Array(Prop),
  annotations: Schema.optional(
    Schema.NullOr(Schema.Struct({ readOnlyHint: Schema.optional(Schema.NullOr(Schema.Boolean)), destructiveHint: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
  ),
});
export type ActionComponent = typeof Component.Type;

const Choice = Schema.Struct({ label: Schema.String, value: Schema.Unknown });
export type OptionChoice = typeof Choice.Type;

const ListResponse = Schema.Struct({ data: Schema.Array(Component) });
const RetrieveResponse = Schema.Struct({ data: Component });
const ReloadResponse = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  dynamicProps: Schema.Struct({ id: Schema.String, configurableProps: Schema.Array(Prop) }),
});
const ConfigureResponse = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  options: Schema.optional(Schema.NullOr(Schema.Array(Schema.Union(Choice, Schema.Struct({ __lv: Choice }))))),
  stringOptions: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  context: Schema.optional(Schema.Unknown),
});
const RunResponse = Schema.Struct({
  exports: Schema.optional(Schema.Unknown),
  ret: Schema.optional(Schema.Unknown),
  os: Schema.optional(Schema.Array(Schema.Struct({ err: Schema.optional(Schema.Unknown), msg: Schema.optional(Schema.String) }))),
});
const TokenResponse = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number });

/** One component call on behalf of a connected account's external user. */
interface ComponentRequest {
  readonly id: string;
  readonly version: string;
  readonly external_user_id: string;
  readonly configured_props: Readonly<Record<string, unknown>>;
  readonly dynamic_props_id?: string | undefined;
}

export interface ProxyRequest {
  readonly external_user_id: string;
  readonly account_id: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly url: string;
  /** Forwarded upstream (sent with the `x-pd-proxy-` prefix). */
  readonly headers: Readonly<Record<string, string>>;
  /** Sent byte-for-byte; never JSON-encoded. */
  readonly body?: Uint8Array;
}

interface PipedreamService {
  readonly searchActions: (query: { readonly q: string; readonly app: string; readonly limit: number }) => Effect.Effect<ReadonlyArray<ActionComponent>, IntegrationFailure>;
  /** Current definition, or null when the action no longer exists. */
  readonly getAction: (key: string) => Effect.Effect<ActionComponent | null, IntegrationFailure>;
  readonly reloadProps: (request: ComponentRequest) => Effect.Effect<{ readonly id: string; readonly props: ReadonlyArray<ActionProp> }, IntegrationFailure>;
  /** One upstream page of remote options; `context` non-null means another page exists. */
  readonly configureProp: (
    request: ComponentRequest & { readonly prop_name: string; readonly page: number; readonly prev_context: unknown },
  ) => Effect.Effect<{ readonly options: ReadonlyArray<OptionChoice>; readonly context: unknown }, IntegrationFailure>;
  readonly runAction: (request: ComponentRequest) => Effect.Effect<{ readonly exports: unknown; readonly ret: unknown }, IntegrationFailure>;
  /** Upstream response body; non-2xx upstream responses fail. */
  readonly proxy: (request: ProxyRequest) => Effect.Effect<Uint8Array, IntegrationFailure>;
}

export class PipedreamClient extends Context.Tag('sanctum/PipedreamClient')<PipedreamClient, PipedreamService>() {}

/** Connection failures that prove the request never left this host. */
const NOT_SENT: ReadonlyArray<unknown> = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];

const failure = (message: string, status: number | null, retryable: boolean, ambiguous: boolean) => new IntegrationFailure({ message, status, retryable, ambiguous });

const unconfigured: PipedreamService = (() => {
  const refuse = () => Effect.fail(failure('Pipedream is not configured', null, false, false));
  return { searchActions: refuse, getAction: refuse, reloadProps: refuse, configureProp: refuse, runAction: refuse, proxy: refuse };
})();

const componentBody = (request: ComponentRequest) => ({
  id: request.id,
  version: request.version,
  external_user_id: request.external_user_id,
  configured_props: request.configured_props,
  ...(request.dynamic_props_id ? { dynamic_props_id: request.dynamic_props_id } : {}),
});

const noErrors = (operation: string, errors: ReadonlyArray<string> | null | undefined) =>
  errors && errors.length > 0 ? Effect.fail(failure(`${operation}: ${errors.join('; ')}`, null, false, false)) : Effect.void;

/** Live client over the Connect REST API with an OAuth client-credentials token. */
export const makePipedreamClient = (config: ServerConfig['pipedream']): PipedreamService => {
  if (Option.isNone(config.credentials)) return unconfigured;
  const credentials = config.credentials.value;
  const timeoutMs = engineeringDefaults.pipedream.requestTimeoutMs;
  let token: { readonly value: string; readonly expiresAt: number } | null = null;

  /** `write`: the request may change upstream state, so a lost or 5xx response is ambiguous. */
  const send = (path: string, init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array; write: boolean; bearer?: string }) =>
    Effect.gen(function*() {
      const response = yield* Effect.tryPromise({
        try: signal =>
          fetch(`${config.apiUrl}${path}`, {
            method: init.method,
            headers: { ...(init.bearer ? { authorization: `Bearer ${init.bearer}`, 'x-pd-environment': config.environment } : {}), ...init.headers },
            ...(init.body === undefined ? {} : { body: init.body }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
          }),
        catch: cause => {
          const code = cause instanceof Error && cause.cause instanceof Error && 'code' in cause.cause ? cause.cause.code : undefined;
          return failure(`Pipedream request failed: ${String(cause)}`, null, true, init.write && !NOT_SENT.includes(code));
        },
      });
      const body = new Uint8Array(
        yield* Effect.tryPromise({ try: () => response.arrayBuffer(), catch: () => failure('Pipedream response was cut off', response.status, true, init.write) }),
      );
      if (response.ok) return body;
      const detail = new TextDecoder().decode(body.subarray(0, 300));
      const status = response.status;
      return yield* Effect.fail(failure(`Pipedream responded ${status}: ${detail}`, status, status === 429 || status >= 500, init.write && status >= 500));
    });

  const accessToken = Effect.gen(function*() {
    if (token && token.expiresAt > Date.now()) return token.value;
    const body = JSON.stringify({ grant_type: 'client_credentials', client_id: credentials.clientId, client_secret: Redacted.value(credentials.clientSecret) });
    const raw = yield* send('/v1/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body, write: false });
    const decoded = yield* decode(TokenResponse, raw, false);
    token = { value: decoded.access_token, expiresAt: Date.now() + (decoded.expires_in - 60) * 1000 };
    return decoded.access_token;
  });

  const decode = <A, I>(schema: Schema.Schema<A, I>, raw: Uint8Array, write: boolean) =>
    Effect.try({ try: () => JSON.parse(new TextDecoder().decode(raw)) as unknown, catch: () => failure('Pipedream returned invalid JSON', null, false, write) }).pipe(
      Effect.flatMap(Schema.decodeUnknown(schema)),
      Effect.mapError(error => (error instanceof IntegrationFailure ? error : failure(`Unexpected Pipedream response: ${error.message}`, null, false, write))),
    );

  const project = `/v1/connect/${encodeURIComponent(credentials.projectId)}`;
  const api = <A, I>(schema: Schema.Schema<A, I>, path: string, options: { json?: unknown; write?: boolean } = {}) =>
    Effect.gen(function*() {
      const write = options.write ?? false;
      const bearer = yield* accessToken;
      const init = options.json === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.json) };
      return yield* decode(schema, yield* send(`${project}${path}`, { ...init, write, bearer }), write);
    });

  return {
    searchActions: ({ q, app, limit }) =>
      api(ListResponse, `/actions?${new URLSearchParams({ q, app, limit: String(limit) })}`).pipe(Effect.map(response => response.data)),
    getAction: key =>
      api(RetrieveResponse, `/actions/${encodeURIComponent(key)}`).pipe(
        Effect.map(response => response.data),
        Effect.catchIf(error => error.status === 404, () => Effect.succeed(null)),
      ),
    reloadProps: request =>
      api(ReloadResponse, '/actions/props', { json: { ...componentBody(request), blocking: true } }).pipe(
        Effect.tap(response => noErrors('Reload props', response.errors)),
        Effect.map(response => ({ id: response.dynamicProps.id, props: response.dynamicProps.configurableProps })),
      ),
    configureProp: request =>
      api(ConfigureResponse, '/actions/configure', {
        json: { ...componentBody(request), prop_name: request.prop_name, page: request.page, prev_context: request.prev_context ?? undefined, blocking: true },
      }).pipe(
        Effect.tap(response => noErrors('Configure prop', response.errors)),
        Effect.map(response => ({
          options: response.options?.map(option => ('__lv' in option ? option.__lv : option)) ?? response.stringOptions?.map(value => ({ label: value, value })) ?? [],
          context: response.context ?? null,
        })),
      ),
    runAction: request =>
      api(RunResponse, '/actions/run', { json: componentBody(request), write: true }).pipe(
        Effect.flatMap(response => {
          const error = response.os?.find(entry => entry.err !== undefined);
          // The action code ran and reported an error: its side effects are unknown.
          return error ? Effect.fail(failure(`Action reported an error: ${error.msg ?? 'unknown'}`, null, false, true)) : Effect.succeed({ exports: response.exports ?? null, ret: response.ret ?? null });
        }),
      ),
    proxy: request =>
      Effect.gen(function*() {
        const bearer = yield* accessToken;
        const target = Buffer.from(request.url).toString('base64url');
        const query = new URLSearchParams({ external_user_id: request.external_user_id, account_id: request.account_id });
        const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [`x-pd-proxy-${name.toLowerCase()}`, value]));
        const contentType = request.headers['content-type'];
        return yield* send(`${project}/proxy/${target}?${query}`, {
          method: request.method,
          headers: { ...headers, ...(contentType ? { 'content-type': contentType } : {}) },
          ...(request.body ? { body: request.body } : {}),
          write: request.method !== 'GET',
          bearer,
        });
      }),
  };
};

export const PipedreamLive = Layer.effect(
  PipedreamClient,
  Effect.map(serverConfig, config => makePipedreamClient(config.pipedream)),
);

/** Test catalog entry: a component plus fixture-only behavior. */
export interface FixtureAction extends ActionComponent {
  /** Remote options per prop name. */
  readonly options?: Readonly<Record<string, ReadonlyArray<OptionChoice>>>;
  /** Props added by `reloadProps` once the configured props are known (dynamic schema). */
  readonly dynamicProps?: (configured: Readonly<Record<string, unknown>>) => ReadonlyArray<ActionProp>;
  readonly ret?: unknown;
}

type Operation = keyof PipedreamService;

/** One recorded fixture call, typed by operation. */
type FixtureCall = { [K in Operation]: { readonly operation: K; readonly request: Parameters<PipedreamService[K]>[0] } }[Operation];

export interface PipedreamFixture {
  readonly layer: Layer.Layer<PipedreamClient>;
  /** Mutable catalog by key: replace an entry to simulate a version bump. */
  readonly actions: Map<string, FixtureAction>;
  readonly calls: ReadonlyArray<FixtureCall>;
  /** The next call of `operation` fails with `error`. */
  readonly failNext: (operation: Operation, error: IntegrationFailure) => void;
  /** JSON body the fixture proxy answers with. */
  readonly respondToProxy: (respond: (request: ProxyRequest) => unknown) => void;
}

/** Upstream page size of fixture remote options. */
const FIXTURE_OPTIONS_PAGE = 50;

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * In-memory Pipedream for tests and local development without credentials: a mutable catalog,
 * recorded calls, and one-shot failures.
 */
export const fixturePipedream = (catalog: ReadonlyArray<FixtureAction>): PipedreamFixture => {
  const actions = new Map(catalog.map(action => [action.key, action]));
  const calls: Array<FixtureCall> = [];
  const failures = new Map<Operation, IntegrationFailure>();
  let proxyResponse: (request: ProxyRequest) => unknown = () => ({});

  const call = <K extends Operation, A>(operation: K, request: Parameters<PipedreamService[K]>[0], run: () => A): Effect.Effect<A, IntegrationFailure> =>
    Effect.suspend(() => {
      // TypeScript cannot correlate `operation` and `request` through the generic `K`.
      const recorded = { operation, request } as FixtureCall;
      calls.push(recorded);
      const failed = failures.get(operation);
      failures.delete(operation);
      return failed ? Effect.fail(failed) : Effect.sync(run);
    });

  const found = (key: string) => {
    const action = actions.get(key);
    if (!action) throw new Error(`fixture action ${key} is missing`);
    return action;
  };

  const service: PipedreamService = {
    searchActions: query =>
      call('searchActions', query, () => {
        const terms = words(query.q);
        const scored = [...actions.values()]
          .filter(action => action.configurable_props.some(prop => prop.type === 'app' && prop.app === query.app))
          .map(action => {
            const text = new Set(words(`${action.key} ${action.name} ${action.description ?? ''}`));
            return { action, score: terms.filter(term => text.has(term)).length };
          })
          .filter(entry => entry.score > 0);
        scored.sort((a, b) => b.score - a.score || a.action.key.localeCompare(b.action.key));
        return scored.slice(0, query.limit).map(entry => entry.action);
      }),
    getAction: key => call('getAction', key, () => actions.get(key) ?? null),
    reloadProps: request =>
      call('reloadProps', request, () => {
        const action = found(request.id);
        const props = [...action.configurable_props, ...(action.dynamicProps?.(request.configured_props) ?? [])];
        return { id: `dyn_${props.map(prop => prop.name).join('_')}`, props };
      }),
    configureProp: request =>
      call('configureProp', request, () => {
        const all = found(request.id).options?.[request.prop_name] ?? [];
        const start = request.page * FIXTURE_OPTIONS_PAGE;
        const more = start + FIXTURE_OPTIONS_PAGE < all.length;
        return { options: all.slice(start, start + FIXTURE_OPTIONS_PAGE), context: more ? { page: request.page + 1 } : null };
      }),
    runAction: request => call('runAction', request, () => ({ exports: { $summary: `ran ${request.id}` }, ret: found(request.id).ret ?? null })),
    proxy: request => call('proxy', request, () => new TextEncoder().encode(JSON.stringify(proxyResponse(request)))),
  };

  return {
    layer: Layer.succeed(PipedreamClient, service),
    actions,
    calls,
    failNext: (operation, error) => {
      failures.set(operation, error);
    },
    respondToProxy: respond => {
      proxyResponse = respond;
    },
  };
};
