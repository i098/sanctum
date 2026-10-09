/**
 * Embedded OIDC issuer and MCP authorization server for self-hosting (docs/DECISIONS.md, sign-in):
 * Better Auth at `/idp` when `SANCTUM_EMBEDDED_ISSUER=better-auth`. It keeps its own small mysql2
 * pool and the `auth_*` tables of migration 011; Sanctum never runs Better Auth's migrator. Login
 * ID tokens and MCP access tokens carry the same `iss` and `sub`, so one `principal_identities`
 * row serves both, and mcp.ts verifies these tokens like any other authorization server's.
 */
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { type ClientMetadataResourceFetch, oauthProvider } from '@better-auth/oauth-provider';
import { HttpApiBuilder, HttpApp } from '@effect/platform';
import { NodeRuntime } from '@effect/platform-node';
import { type BetterAuthPlugin, betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { jwt } from 'better-auth/plugins';
import { Config, Effect, Option, Redacted } from 'effect';
import { createPool } from 'mysql2/promise';
import { serverConfig } from './config.ts';
import type { MysqlOptions } from './db.ts';
import { MCP_SCOPES } from './mcp.ts';

/** Better Auth's base path; the public issuer is `<origin>/idp`. */
const ISSUER_PATH = '/idp';

export interface IssuerSettings {
  /** `SANCTUM_OIDC_ISSUER`, `https://<host>/idp`; its origin is Better Auth's base URL. */
  readonly issuer: URL;
  /** `SANCTUM_MCP_RESOURCE`, the audience of every MCP access token. */
  readonly resource: URL;
  readonly secret: Redacted.Redacted;
}

/** `None` unless `SANCTUM_EMBEDDED_ISSUER=better-auth`; then the issuer, resource and secret are required. */
const issuerSettings = Effect.gen(function* () {
  const mode = yield* Config.option(Config.literal('better-auth')('SANCTUM_EMBEDDED_ISSUER'));
  if (Option.isNone(mode)) return Option.none<IssuerSettings>();
  return Option.some<IssuerSettings>(
    yield* Config.all({
      issuer: Config.url('SANCTUM_OIDC_ISSUER').pipe(
        Config.validate({ message: `must be <origin>${ISSUER_PATH} for the embedded issuer`, validation: url => url.pathname === ISSUER_PATH }),
      ),
      resource: Config.url('SANCTUM_MCP_RESOURCE'),
      secret: Config.redacted('BETTER_AUTH_SECRET').pipe(
        Config.validate({ message: 'must be at least 32 characters', validation: secret => Redacted.value(secret).length >= 32 }),
      ),
    }),
  );
});

/** Hosts a native client may use for `http` redirects (RFC 8252 §7.3); the port is free. */
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, '127.0.0.1': true, '[::1]': true };
const isHttpLoopback = (value: unknown) => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && Object.hasOwn(LOOPBACK_HOSTS, url.hostname);
  } catch {
    return false;
  }
};

/**
 * OIDC treats a registration without `application_type` as `web`, which Better Auth rejects for
 * loopback redirects, yet MCP clients register `http://127.0.0.1:<port>/callback` without it. When
 * every redirect URI is an http loopback URI, the type defaults to `native`; nothing else changes.
 */
const loopbackClientsAreNative = {
  id: 'sanctum-loopback-native',
  hooks: {
    before: [
      {
        matcher: (ctx: { path?: string }) => ctx.path === '/oauth2/register',
        handler: createAuthMiddleware(async ctx => {
          const body = ctx.body as { application_type?: unknown; redirect_uris?: unknown } | undefined;
          const uris = body?.redirect_uris;
          if (body?.application_type !== undefined || !Array.isArray(uris) || uris.length === 0 || !uris.every(isHttpLoopback)) return;
          return { context: { ...ctx, body: { ...body, application_type: 'native' } } };
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

/** What a client is offered when it registers or authorizes without naming `scope`: no action scopes. */
const DEFAULT_CLIENT_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'context:read', 'context:write', 'recordings:read'];

/**
 * Better Auth stores every dynamic and metadata-document client with all registrable scopes and,
 * when `/oauth2/authorize` carries no `scope`, requests all of them. Filling the default list in
 * first keeps `actions:request` and `actions:execute` for clients that name them explicitly.
 */
const scopelessAuthorizeGetsDefaults = {
  id: 'sanctum-default-scopes',
  hooks: {
    before: [
      {
        matcher: (ctx: { path?: string }) => ctx.path === '/oauth2/authorize',
        handler: createAuthMiddleware(async ctx => {
          const field = ctx.method === 'POST' ? 'body' : 'query';
          const params = (ctx[field] ?? {}) as { scope?: unknown };
          if (params.scope !== undefined) return;
          return { context: { ...ctx, [field]: { ...params, scope: DEFAULT_CLIENT_SCOPES.join(' ') } } };
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

/** Shared by the server, `issuer:client` and the schema test so all three see the same tables. `fetchMetadata` is the SSRF-safe CIMD transport; tests substitute it. */
export const createIssuer = (settings: IssuerSettings, mysql: MysqlOptions, fetchMetadata: ClientMetadataResourceFetch = fetchClientMetadataResource) => {
  const pool = createPool({
    host: mysql.host,
    port: mysql.port,
    database: mysql.database,
    user: mysql.username,
    password: Redacted.value(mysql.password),
    timezone: 'Z',
    connectionLimit: 2,
    ...(mysql.caCert === undefined ? {} : { ssl: { ca: mysql.caCert, verifyIdentity: true } }),
  });
  const resource = settings.resource.href;
  const provider = oauthProvider({
    loginPage: '/sign-in',
    consentPage: '/consent',
    scopes: ['openid', 'profile', 'email', 'offline_access', ...MCP_SCOPES],
    clientRegistrationDefaultScopes: DEFAULT_CLIENT_SCOPES,
    clientRegistrationAllowedScopes: ['actions:request', 'actions:execute'],
    resources: [{ identifier: resource, allowedScopes: [...MCP_SCOPES] }],
    clientRegistrationDefaultResources: [resource],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    schema: {
      oauthClient: { modelName: 'auth_oauth_client' },
      oauthResource: { modelName: 'auth_oauth_resource' },
      oauthClientResource: { modelName: 'auth_oauth_client_resource' },
      oauthRefreshToken: { modelName: 'auth_oauth_refresh_token' },
      oauthAccessToken: { modelName: 'auth_oauth_access_token' },
      oauthConsent: { modelName: 'auth_oauth_consent' },
      oauthClientAssertion: { modelName: 'auth_oauth_client_assertion' },
    },
  });
  const auth = betterAuth({
    baseURL: settings.issuer.origin,
    basePath: ISSUER_PATH,
    secret: Redacted.value(settings.secret),
    database: pool,
    emailAndPassword: { enabled: true },
    user: { modelName: 'auth_user' },
    session: { modelName: 'auth_session' },
    account: { modelName: 'auth_account' },
    verification: { modelName: 'auth_verification' },
    // The JWT plugin's session-token endpoint is not an OAuth grant; tokens come from /oauth2/token only.
    disabledPaths: ['/token'],
    plugins: [
      jwt({ schema: { jwks: { modelName: 'auth_jwks' } } }),
      // better-auth 1.7.7's OpenAPI metadata types fail `exactOptionalPropertyTypes`; the intersection keeps the endpoint types.
      provider as typeof provider & BetterAuthPlugin,
      cimd({ fetchClientMetadataResource: fetchMetadata }),
      loopbackClientsAreNative,
      scopelessAuthorizeGetsDefaults,
    ],
  });
  return { auth, pool };
};

/** Mounts `/idp/*` and its RFC 8414 alias when configured; the pool closes with the server scope. */
export const embeddedIssuerLive = (mysql: MysqlOptions) =>
  HttpApiBuilder.Router.use(router =>
    Effect.gen(function* () {
      const settings = yield* issuerSettings;
      if (Option.isNone(settings)) return;
      const { auth } = yield* Effect.acquireRelease(
        Effect.sync(() => createIssuer(settings.value, mysql)),
        ({ pool }) => Effect.promise(() => pool.end()),
      );
      const app = HttpApp.fromWebHandler(auth.handler);
      yield* router.all(`${ISSUER_PATH}/*`, app);
      yield* router.all(`/.well-known/oauth-authorization-server${ISSUER_PATH}`, app);
    }),
  );

/**
 * Registers Sanctum's own sign-in client (public, PKCE, no consent screen) for `redirect` and
 * returns its id. Better Auth's admin create endpoint needs a signed-in user, so this registers
 * through the validated DCR path and then sets the one restricted flag, `skipConsent`, on the stored row.
 */
export const registerSanctumClient = (settings: IssuerSettings, mysql: MysqlOptions, redirect: URL) =>
  Effect.acquireUseRelease(
    Effect.sync(() => createIssuer(settings, mysql)),
    ({ auth }) =>
      Effect.promise(async () => {
        // Present at runtime; the typing workaround in createIssuer makes every endpoint optional.
        const { client_id } = await auth.api.registerOAuthClient!({
          body: { client_name: 'Sanctum', redirect_uris: [redirect.href], token_endpoint_auth_method: 'none' },
        });
        const { adapter } = await auth.$context;
        await adapter.update({ model: 'oauthClient', where: [{ field: 'clientId', value: client_id }], update: { skipConsent: true } });
        return client_id;
      }),
    ({ pool }) => Effect.promise(() => pool.end()),
  );

/** `npm run issuer:client -w server`: prints the id of a new client for `SANCTUM_OIDC_CLIENT_ID`; redirect is `SANCTUM_OIDC_REDIRECT_URI`. */
if (import.meta.main) {
  Effect.gen(function* () {
    const settings = yield* issuerSettings;
    if (Option.isNone(settings)) return yield* Effect.dieMessage('Set SANCTUM_EMBEDDED_ISSUER=better-auth first');
    const redirect = yield* Config.url('SANCTUM_OIDC_REDIRECT_URI');
    const { mysql } = yield* serverConfig;
    console.log(yield* registerSanctumClient(settings.value, mysql, redirect));
  }).pipe(NodeRuntime.runMain);
}
