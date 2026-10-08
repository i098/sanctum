/**
 * Embedded OIDC issuer and MCP authorization server for self-hosting (docs/DECISIONS.md, sign-in):
 * Better Auth at `/idp` when `SANCTUM_EMBEDDED_ISSUER=better-auth`. It keeps its own small mysql2
 * pool and the `auth_*` tables of migration 011; Sanctum never runs Better Auth's migrator. Login
 * ID tokens and MCP access tokens carry the same `iss` and `sub`, so one `principal_identities`
 * row serves both, and mcp.ts verifies these tokens like any other authorization server's.
 */
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { oauthProvider } from '@better-auth/oauth-provider';
import { HttpApiBuilder, HttpApp } from '@effect/platform';
import { NodeRuntime } from '@effect/platform-node';
import { type BetterAuthPlugin, betterAuth } from 'better-auth';
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

/** Shared by the server, `issuer:client` and the schema test so all three see the same tables. */
export const createIssuer = (settings: IssuerSettings, mysql: MysqlOptions) => {
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
      cimd({ fetchClientMetadataResource }),
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
 * `npm run issuer:client -w server`: registers Sanctum's own sign-in client (public, PKCE, no
 * consent screen, redirect `SANCTUM_OIDC_REDIRECT_URI`) and prints the id for `SANCTUM_OIDC_CLIENT_ID`.
 * Better Auth's admin create endpoint needs a signed-in user, so this registers through the
 * validated DCR path and then sets the one restricted flag, `skipConsent`, on the stored row.
 */
if (import.meta.main) {
  Effect.gen(function* () {
    const settings = yield* issuerSettings;
    if (Option.isNone(settings)) return yield* Effect.dieMessage('Set SANCTUM_EMBEDDED_ISSUER=better-auth first');
    const redirect = yield* Config.url('SANCTUM_OIDC_REDIRECT_URI');
    const { mysql } = yield* serverConfig;
    const clientId = yield* Effect.acquireUseRelease(
      Effect.sync(() => createIssuer(settings.value, mysql)),
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
    console.log(clientId);
  }).pipe(NodeRuntime.runMain);
}
