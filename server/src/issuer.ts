/**
 * Embedded OIDC issuer and MCP authorization server for self-hosting (docs/DECISIONS.md, sign-in):
 * Better Auth at `/idp` when `SANCTUM_EMBEDDED_ISSUER=better-auth`. It keeps its own small mysql2
 * pool and the `auth_*` tables of migrations 011 and 013; Sanctum never runs Better Auth's migrator. Login
 * ID tokens and MCP access tokens carry the same `iss` and `sub`, so one `principal_identities`
 * row serves both, and mcp.ts verifies these tokens like any other authorization server's.
 * Its organizations are the teams of Sanctum workspaces (issuer-orgs.ts).
 */
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { type ClientMetadataResourceFetch, oauthProvider } from '@better-auth/oauth-provider';
import { HttpApiBuilder, HttpApp } from '@effect/platform';
import { NodeRuntime } from '@effect/platform-node';
import { SqlClient } from '@effect/sql';
import { type BetterAuthPlugin, betterAuth } from 'better-auth';
// `better-auth/api` through the `imports` alias in package.json: Sentrux resolves that specifier to server/src/api.ts.
import { APIError, createAuthMiddleware, getSessionFromCtx } from '#better-auth-api';
import { jwt, organization } from 'better-auth/plugins';
import { Config, Effect, Either, Option, Redacted } from 'effect';
import { createPool } from 'mysql2/promise';
import { serverConfig } from './config.ts';
import type { MysqlOptions } from './db.ts';
import { applyMember, requireSeat, workspaceOrganization } from './issuer-orgs.ts';
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

/** A plugin that rewrites the request context of `path` before Better Auth handles it; `rewrite` returns the context fields to replace, or nothing. */
const rewritesRequest = (id: string, path: string, rewrite: (ctx: { method?: string; body?: unknown; query?: unknown }) => object | undefined) =>
  ({
    id,
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === path,
          handler: createAuthMiddleware(async ctx => {
            const replaced = rewrite(ctx);
            return replaced && { context: { ...ctx, ...replaced } };
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;

/**
 * OIDC treats a registration without `application_type` as `web`, which Better Auth rejects for
 * loopback redirects, yet MCP clients register `http://127.0.0.1:<port>/callback` without it. When
 * every redirect URI is an http loopback URI, the type defaults to `native`; nothing else changes.
 */
const loopbackClientsAreNative = rewritesRequest('sanctum-loopback-native', '/oauth2/register', ({ body }) => {
  const { application_type, redirect_uris } = (body ?? {}) as { application_type?: unknown; redirect_uris?: unknown };
  if (application_type !== undefined || !Array.isArray(redirect_uris) || redirect_uris.length === 0 || !redirect_uris.every(isHttpLoopback)) return;
  return { body: { ...(body as object), application_type: 'native' } };
});

/** What a client is offered when it registers or authorizes without naming `scope`: no action scopes. */
const DEFAULT_CLIENT_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'context:read', 'context:write', 'recordings:read'];

/**
 * Better Auth stores every dynamic and metadata-document client with all registrable scopes and,
 * when `/oauth2/authorize` carries no `scope`, requests all of them. Filling the default list in
 * first keeps `actions:request` and `actions:execute` for clients that name them explicitly.
 */
const scopelessAuthorizeGetsDefaults = rewritesRequest('sanctum-default-scopes', '/oauth2/authorize', ctx => {
  const field = ctx.method === 'POST' ? 'body' : 'query';
  const params = (ctx[field] ?? {}) as { scope?: unknown };
  if (params.scope !== undefined) return;
  return { [field]: { ...params, scope: DEFAULT_CLIENT_SCOPES.join(' ') } };
});

/** Pending invitations carry the ids that accept them, so only an owner or admin of the organization gets them back from `get-full-organization`; for anyone else the list is empty. */
const invitationsOnlyForManagers = {
  id: 'sanctum-invitations-for-managers',
  hooks: {
    after: [
      {
        matcher: (ctx: { path?: string }) => ctx.path === '/organization/get-full-organization',
        handler: createAuthMiddleware(async ctx => {
          const returned = ctx.context.returned as { members?: ReadonlyArray<{ userId: string; role: string }> } | null;
          if (!returned?.members) return;
          const session = await getSessionFromCtx(ctx);
          const mine = returned.members.find(member => member.userId === session?.user.id);
          if (mine?.role.split(',').some(role => ['owner', 'admin'].includes(role.trim()))) return;
          ctx.context.returned = { ...returned, invitations: [] };
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

/**
 * Shared by the server, `issuer:client` and the schema test so all three see the same tables. `fetchMetadata` is the SSRF-safe CIMD transport; tests substitute it.
 * `sql` is the API's database client, which organization changes need for Sanctum's side; without it they fail.
 */
export const createIssuer = (
  settings: IssuerSettings,
  mysql: MysqlOptions,
  fetchMetadata: ClientMetadataResourceFetch = fetchClientMetadataResource,
  sql?: SqlClient.SqlClient,
) => {
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
  const issuer = settings.issuer.href;
  /** Makes the hook of one organization change that runs Sanctum's side: a refusal answers 403 with its message and stops the change; a database error answers 500. */
  const sanctum =
    <D, A, E extends { readonly _tag: string; readonly message: string }>(change: (data: D) => Effect.Effect<A, E, SqlClient.SqlClient>) =>
    async (data: D) => {
      if (sql === undefined) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Organizations change only through the API process' });
      const result = await Effect.runPromise(Effect.either(Effect.provideService(change(data), SqlClient.SqlClient, sql)));
      if (Either.isRight(result)) return result.right;
      if (result.left._tag === 'SqlError') throw result.left;
      throw new APIError('FORBIDDEN', { message: result.left.message });
    };
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
    // The authorizing session's active organization becomes the access token's `org_id`, which selects the workspace at /mcp.
    postLogin: {
      page: '/sign-in',
      shouldRedirect: () => false,
      consentReferenceId: ({ session }) => (typeof session['activeOrganizationId'] === 'string' ? session['activeOrganizationId'] : undefined),
    },
    customAccessTokenClaims: ({ referenceId }) => (referenceId === undefined ? {} : { org_id: referenceId }),
    // Sanctum reads the display name from the ID token at sign-in (plan section 5.2); the library emits no profile claims by itself.
    customIdTokenClaims: ({ user, scopes }) => (scopes.includes('profile') ? { name: user.name } : {}),
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
    // Leaving runs no organization hook, so a member leaves only by an admin's removal, which Sanctum sees.
    // Both list invitations (and so their ids), the first to anyone with an invited address and the second to every member: pending invitations come only through get-full-organization, for owners and admins.
    disabledPaths: ['/token', '/organization/leave', '/organization/list-user-invitations', '/organization/list-invitations'],
    plugins: [
      jwt({ schema: { jwks: { modelName: 'auth_jwks' } } }),
      // better-auth 1.7.7's OpenAPI metadata types fail `exactOptionalPropertyTypes`; the intersection keeps the endpoint types.
      provider as typeof provider & BetterAuthPlugin,
      cimd({ fetchClientMetadataResource: fetchMetadata }),
      loopbackClientsAreNative,
      scopelessAuthorizeGetsDefaults,
      invitationsOnlyForManagers,
      // No email transport: inviters copy the link. Sign-up is open and email unverified, so anyone can register an invited address: the invitation id is the secret, seen only by owners and admins, and no invitation carries `owner`.
      // Once SMTP exists, send invitations by email and set `requireEmailVerificationOnInvitation: true` (docs/operations.md).
      organization({
        schema: { organization: { modelName: 'auth_organization' }, member: { modelName: 'auth_member' }, invitation: { modelName: 'auth_invitation' } },
        // Sanctum's seat limit applies instead (store.ts `claimSeat`); a workspace is deleted in Sanctum, never through its organization.
        // Finite, because member lists also use it as their SQL LIMIT.
        membershipLimit: Number.MAX_SAFE_INTEGER,
        disableOrganizationDeletion: true,
        organizationHooks: {
          beforeCreateInvitation: async ({ invitation }) => {
            if (invitation.role.split(',').some(role => role.trim() === 'owner')) throw new APIError('FORBIDDEN', { message: 'An owner is made by changing a member\'s role, not by invitation' });
          },
          beforeCreateOrganization: sanctum(({ organization, user }) => Effect.map(workspaceOrganization(issuer, organization.slug, user), workspace => ({ data: { ...organization, ...workspace } }))),
          afterCreateOrganization: sanctum(({ organization, user }) => applyMember(issuer, organization.id, user, 'owner', true)),
          beforeAcceptInvitation: sanctum(({ invitation, user }) => requireSeat(issuer, invitation.organizationId, user)),
          afterAcceptInvitation: sanctum(({ member, user }) => applyMember(issuer, member.organizationId, user, member.role, true)),
          afterUpdateMemberRole: sanctum(({ member, user }) => applyMember(issuer, member.organizationId, user, member.role, false)),
          beforeRemoveMember: sanctum(({ member, user }) => applyMember(issuer, member.organizationId, user, null, false)),
        },
      }),
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
      const sql = yield* SqlClient.SqlClient;
      const { auth } = yield* Effect.acquireRelease(
        Effect.sync(() => createIssuer(settings.value, mysql, undefined, sql)),
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
