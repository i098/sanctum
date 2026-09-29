/**
 * Remote MCP (plan section 13): eleven explicit tools over Streamable HTTP at `/mcp`.
 * A tool runs the same v1 REST handler the SDKs and website call, in-process, as the principal
 * its delegated OAuth token maps to, so validation, authorization and errors cannot drift.
 * The authorization server is unselected (docs/DECISIONS.md): tokens are verified against the
 * configured issuer, audience-bound to this resource; with no issuer configured MCP refuses.
 */
import { randomUUID } from 'node:crypto';
import { HttpApi, HttpApiBuilder, HttpApp, type HttpRouter, HttpServerRequest, HttpServerResponse } from '@effect/platform';
import { SqlClient, SqlSchema } from '@effect/sql';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  AccessScope,
  AccessScopeName,
  Forbidden,
  PrincipalId,
  SanctumApi,
  Unauthenticated,
  Unavailable,
  WorkspaceId,
} from '@sanctum/contracts';
import { Config, Context, Effect, Either, JSONSchema, Layer, Option, ParseResult, Schema, SchemaAST } from 'effect';
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { Authenticator, resolveAccess } from './auth.ts';

/** Tool name, v1 route it runs, and the description agents see. Nothing else is exposed. */
const TOOLS = [
  ['list_meetings', 'GET /api/v1/meetings', 'List meetings the caller may read, with cursor paging.'],
  ['get_context', 'GET /api/v1/meetings/:meeting_id/context', 'Bounded, source-linked context snapshot of one meeting and its revision.'],
  ['search_context', 'GET /api/v1/context/search', 'Search authorized context items by text.'],
  ['get_source', 'GET /api/v1/sources/:source_id', 'Read the exact cited transcript segment or artifact.'],
  ['get_context_changes', 'GET /api/v1/context/changes', 'Context changes after a cursor; keep next_cursor to resume.'],
  ['add_context', 'POST /api/v1/context/items', 'Add attributed evidence or an observation at expected_revision; retries reuse idempotency_key.'],
  ['revise_context', 'PATCH /api/v1/context/items/:item_id', 'Supersede one item revision; a stale expected_revision returns current_revision.'],
  ['request_action', 'POST /api/v1/actions', 'Request one inspected integration action; execution needs a stored grant.'],
  ['get_action', 'GET /api/v1/actions/:action_id', 'Actual status and provider receipt of a requested action.'],
  ['search_integration_actions', 'GET /api/v1/integrations/actions', 'Find at most five integration actions for an intent, without schemas.'],
  ['get_integration_action', 'POST /api/v1/integrations/actions/:action_key/schema', 'Inputs, configuration and options for one selected action.'],
] as const;

export const MCP_TOOL_NAMES = TOOLS.map(([name]) => name);
const TEXT_LIMIT = 8_000;

interface ToolRoute {
  readonly tool: Tool;
  readonly method: string;
  readonly path: string;
  readonly input: Schema.Schema<unknown, unknown>;
  readonly pathParams: ReadonlyArray<string>;
  readonly queryParams: ReadonlyArray<string>;
  readonly bodyFields: ReadonlyArray<string> | null;
}

const signatures = (schema: Option.Option<{ readonly ast: SchemaAST.AST }>) =>
  Option.match(schema, {
    onNone: () => [],
    onSome: ({ ast }) => {
      if (!SchemaAST.isTypeLiteral(ast)) throw new Error('MCP tools need object-shaped path, query and payload schemas');
      return ast.propertySignatures;
    },
  });

/** Resolves every tool against the v1 contract; a route missing from `SanctumApi` is a startup error. */
export const mcpTools = (api: HttpApi.HttpApi.Any = SanctumApi): ReadonlyArray<ToolRoute> => {
  const routes = new Map<string, ToolRoute>();
  const key = (method: string, path: string) => `${method} ${path.replace(/:\w+/g, ':')}`;
  const wanted = new Map(TOOLS.map(([name, route, description]) => [key(...(route.split(' ') as [string, string])), { name, description }]));
  HttpApi.reflect(api as HttpApi.HttpApi.AnyWithProps, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      const want = wanted.get(key(endpoint.method, endpoint.path));
      if (want === undefined) return;
      const [path, query, body] = [endpoint.pathSchema, endpoint.urlParamsSchema, endpoint.payloadSchema].map(signatures) as [
        ReadonlyArray<SchemaAST.PropertySignature>,
        ReadonlyArray<SchemaAST.PropertySignature>,
        ReadonlyArray<SchemaAST.PropertySignature>,
      ];
      // Query strings carry numbers as text; MCP arguments are JSON, so query fields take their decoded type.
      const typedQuery = query.map(p => new SchemaAST.PropertySignature(p.name, SchemaAST.typeAST(p.type), p.isOptional, p.isReadonly));
      const input = Schema.make<unknown, unknown, never>(new SchemaAST.TypeLiteral([...path, ...typedQuery, ...body], []));
      const output = JSONSchema.make(endpoint.successSchema);
      routes.set(want.name, {
        tool: {
          name: want.name,
          description: want.description,
          inputSchema: { ...JSONSchema.make(input), type: 'object' },
          ...('type' in output && output.type === 'object' ? { outputSchema: { ...output, type: 'object' } } : {}),
          annotations: {
            readOnlyHint: endpoint.method === 'GET',
            destructiveHint: false,
            idempotentHint: endpoint.method === 'GET' || body.some(p => p.name === 'idempotency_key'),
            openWorldHint: want.name.includes('action'),
          },
        },
        method: endpoint.method,
        path: endpoint.path,
        input,
        pathParams: path.map(p => String(p.name)),
        queryParams: query.map(p => String(p.name)),
        bodyFields: Option.isSome(endpoint.payloadSchema) ? body.map(p => String(p.name)) : null,
      });
    },
  });
  const missing = MCP_TOOL_NAMES.filter(name => !routes.has(name));
  if (missing.length > 0) throw new Error(`MCP tools without a v1 route: ${missing.join(', ')}`);
  return MCP_TOOL_NAMES.map(name => routes.get(name)!);
};

/** Access resolved by MCP for one dispatched request; never set for requests arriving over the network. */
class McpDelegatedAccess extends Context.Tag('sanctum/McpDelegatedAccess')<McpDelegatedAccess, AccessScope>() {}

/** REST authentication that honours MCP's in-process dispatch before the configured authenticator. */
export const withMcpDelegation = <E, R>(authenticator: Layer.Layer<Authenticator, E, R>) =>
  Layer.effect(
    Authenticator,
    Effect.map(Authenticator, inner => ({
      authenticate: (request: HttpServerRequest.HttpServerRequest) =>
        Effect.flatMap(Effect.serviceOption(McpDelegatedAccess), delegated =>
          Option.isSome(delegated) ? Effect.succeed(delegated.value) : inner.authenticate(request),
        ),
    })),
  ).pipe(Layer.provide(authenticator));

type Dispatch = (request: Request, context: Context.Context<McpDelegatedAccess>) => Promise<Response>;

function toRequest(route: ToolRoute, args: Readonly<Record<string, unknown>>, signal: AbortSignal) {
  const path = route.path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(String(args[name])));
  const url = new URL(path, 'http://mcp.internal');
  for (const name of route.queryParams) if (args[name] !== undefined) url.searchParams.set(name, String(args[name]));
  const body = route.bodyFields && JSON.stringify(Object.fromEntries(route.bodyFields.filter(f => f in args).map(f => [f, args[f]])));
  return new Request(url, { method: route.method, headers: { 'content-type': 'application/json' }, body, signal });
}

async function callTool(route: ToolRoute, args: unknown, access: AccessScope, dispatch: Dispatch, signal: AbortSignal): Promise<CallToolResult> {
  const decoded = Schema.decodeUnknownEither(route.input)(args ?? {}, { onExcessProperty: 'error' });
  if (Either.isLeft(decoded)) {
    return { isError: true, content: [{ type: 'text', text: ParseResult.TreeFormatter.formatErrorSync(decoded.left) }] };
  }
  // Valid input is already in wire encoding; forward the caller's values unchanged.
  const values = args as Readonly<Record<string, unknown>>;
  const response = await dispatch(toRequest(route, values, signal), Context.make(McpDelegatedAccess, access));
  const text = await response.text();
  const body: unknown = text === '' ? null : JSON.parse(text);
  // Errors carry the shared envelope as text: clients validate structuredContent against the success schema.
  if (!response.ok) return { isError: true, content: [{ type: 'text', text }] };
  const summary = text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)} … (truncated; full result in structuredContent)` : text;
  const structured = typeof body === 'object' && body !== null && !Array.isArray(body) ? { structuredContent: { ...body } } : {};
  return { content: [{ type: 'text', text: summary }], ...structured };
}

const DelegatedAccess = Schema.Struct({ access: AccessScope });

function mcpServer(routes: ReadonlyArray<ToolRoute>, dispatch: Dispatch) {
  const server = new Server({ name: 'sanctum', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: routes.map(route => route.tool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const route = routes.find(r => r.tool.name === request.params.name);
    const delegated = Schema.decodeUnknownOption(DelegatedAccess)(extra.authInfo?.extra);
    if (route === undefined || Option.isNone(delegated)) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool ${request.params.name}` }] };
    }
    return callTool(route, request.params.arguments, delegated.value.access, dispatch, extra.signal);
  });
  return server;
}

/** Delegated-token verification settings; `None` while the authorization server is unselected. */
export interface McpAuthorization {
  /** Canonical URL of `/mcp`, the only audience accepted. */
  readonly resource: string;
  readonly issuer: string;
  readonly keys: JWTVerifyGetKey;
}
export class McpAuthorizationServer extends Context.Tag('sanctum/McpAuthorizationServer')<
  McpAuthorizationServer,
  Option.Option<McpAuthorization>
>() {}

/** `SANCTUM_MCP_RESOURCE`, `SANCTUM_MCP_ISSUER` and `SANCTUM_MCP_JWKS_URL`, all required together. */
export const McpAuthorizationFromEnv = Layer.effect(
  McpAuthorizationServer,
  Effect.map(
    Config.all([
      Config.option(Config.url('SANCTUM_MCP_RESOURCE')),
      Config.option(Config.string('SANCTUM_MCP_ISSUER')),
      Config.option(Config.url('SANCTUM_MCP_JWKS_URL')),
    ]),
    ([resource, issuer, jwks]) =>
      Option.all({ resource, issuer, jwks }).pipe(
        Option.map(value => ({ resource: value.resource.href, issuer: value.issuer, keys: createRemoteJWKSet(value.jwks) })),
      ),
  ),
);

const MCP_SCOPES = AccessScopeName.literals.filter(scope => scope !== 'capture:ingest' && scope !== 'workspace:admin');
const metadataUrl = (resource: string) => new URL(`/.well-known/oauth-protected-resource${new URL(resource).pathname}`, resource).href;

const Identity = Schema.Struct({ principal_id: PrincipalId, workspace_id: WorkspaceId });

/** Verified token -> active membership -> access narrowed to the token's granted scopes. */
const authorize = (auth: McpAuthorization, request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const token = /^Bearer (.+)$/.exec(request.headers['authorization'] ?? '')?.[1];
    if (token === undefined) return yield* new Unauthenticated({ message: 'Bearer token required' });
    const { payload } = yield* Effect.tryPromise({
      try: () => jwtVerify(token, auth.keys, { issuer: auth.issuer, audience: auth.resource, requiredClaims: ['sub', 'exp'] }),
      catch: () => new Unauthenticated({ message: 'Invalid, expired or wrong-audience token' }),
    });
    const sql = yield* SqlClient.SqlClient;
    const identities = yield* SqlSchema.findAll({
      Request: Schema.String,
      Result: Identity,
      execute: subject => sql`
        SELECT i.principal_id, m.workspace_id FROM principal_identities i
        JOIN workspace_members m ON m.principal_id = i.principal_id AND m.revoked_at IS NULL
        WHERE i.issuer = ${auth.issuer} AND i.subject = ${subject}`,
    })(payload.sub!).pipe(Effect.orDie);
    const wanted = typeof payload['workspace_id'] === 'string' ? payload['workspace_id'] : undefined;
    const matches = identities.filter(identity => wanted === undefined || identity.workspace_id === wanted);
    if (matches.length !== 1) return yield* new Forbidden({ message: 'Token does not select exactly one workspace membership' });
    const access = yield* resolveAccess(matches[0]!);
    const granted = new Set(typeof payload['scope'] === 'string' ? payload['scope'].split(' ') : []);
    return { ...access, scopes: access.scopes.filter(scope => granted.has(scope)) };
  });

const challenge = (auth: McpAuthorization, error: Unauthenticated | Forbidden) =>
  HttpServerResponse.unsafeJson(error, {
    status: error._tag === 'Unauthenticated' ? 401 : 403,
    headers: {
      'www-authenticate': `Bearer resource_metadata="${metadataUrl(auth.resource)}", error="${error._tag === 'Unauthenticated' ? 'invalid_token' : 'insufficient_scope'}"`,
    },
  });

interface Session {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly principal: string;
}

/** Mounts `/mcp` and its protected-resource metadata on the API router. */
export const McpLive = HttpApiBuilder.Router.use(router =>
  Effect.gen(function* () {
    const settings = yield* McpAuthorizationServer;
    const routes = mcpTools();
    // Built on first use, once every route is registered; runs the full API with its middleware.
    const runtime = yield* Effect.runtime<HttpApi.Api | HttpRouter.HttpRouter.DefaultServices>();
    const web = yield* Effect.cached(
      HttpApiBuilder.httpApp.pipe(
        Effect.provideService(HttpApiBuilder.Router, router),
        Effect.provide(HttpApiBuilder.Middleware.layer),
        Effect.provide(runtime),
        Effect.map(HttpApp.toWebHandlerRuntime(runtime)),
      ),
    );
    const dispatch: Dispatch = (request, context) => Effect.runPromise(web).then(handler => handler(request, context));
    const sessions = new Map<string, Session>();
    yield* Effect.addFinalizer(() => Effect.promise(() => Promise.all([...sessions.values()].map(s => s.transport.close()))));

    const unconfigured = new Unavailable({ message: 'MCP authorization server is not configured', retryable: false });
    const metadata = Option.match(settings, {
      onNone: () => HttpServerResponse.unsafeJson(unconfigured, { status: 503 }),
      onSome: auth =>
        HttpServerResponse.unsafeJson({
          resource: auth.resource,
          authorization_servers: [auth.issuer],
          scopes_supported: MCP_SCOPES,
          bearer_methods_supported: ['header'],
        }),
    });
    yield* router.get('/.well-known/oauth-protected-resource/mcp', Effect.succeed(metadata));

    const open = (principal: string) => {
      const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: id => void sessions.set(id, { transport, principal }),
        onsessionclosed: id => void sessions.delete(id),
      });
      return mcpServer(routes, dispatch).connect(transport).then(() => transport);
    };

    const handle = (auth: McpAuthorization, request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        if (request.method === 'GET') return HttpServerResponse.empty({ status: 405, headers: { allow: 'POST, DELETE' } });
        const access = yield* authorize(auth, request);
        const principal = `${access.workspace_id}/${access.principal.id}`;
        const id = request.headers['mcp-session-id'];
        const session = id === undefined ? undefined : sessions.get(id);
        if (id !== undefined && session?.principal !== principal) {
          return HttpServerResponse.unsafeJson({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }, { status: 404 });
        }
        return yield* HttpApp.fromWebHandler(async web => {
          const transport = session?.transport ?? (await open(principal));
          return transport.handleRequest(web, { authInfo: { token: '', clientId: principal, scopes: [...access.scopes], extra: { access } } });
        });
      }).pipe(Effect.catchTags({ Unauthenticated: error => Effect.succeed(challenge(auth, error)), Forbidden: error => Effect.succeed(challenge(auth, error)) }));

    yield* router.all(
      '/mcp',
      Effect.flatMap(HttpServerRequest.HttpServerRequest, request =>
        Option.match(settings, {
          onNone: () => Effect.succeed(HttpServerResponse.unsafeJson(unconfigured, { status: 503 })),
          onSome: auth => handle(auth, request),
        }),
      ).pipe(Effect.provideService(SqlClient.SqlClient, yield* SqlClient.SqlClient)),
    );
  }),
);
