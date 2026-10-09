/**
 * Human sign-in through any standard OIDC issuer (WorkOS AuthKit hosted, embedded Better Auth
 * self-hosted): the authorization code flow with `state`, `nonce` and PKCE (whenever the issuer
 * advertises S256, and always for a public client). The verified `(iss, sub)` pair is the only key:
 * it selects a principal, then its one active human membership, and a browser session opens with
 * the cookies the secret login link sets. Membership never follows from an email address.
 */
import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from '@effect/platform';
import { SqlClient, SqlSchema } from '@effect/sql';
import { Forbidden, type NotFound, Unauthenticated, Unavailable, WorkspaceId } from '@sanctum/contracts';
import { ConfigError, Context, Data, Effect, Layer, Option, Redacted, Schema } from 'effect';
import * as oidc from 'openid-client';
import { Authenticator, identityPrincipal, linkIdentity, openSession, ownerUntilPurge, revokeSession, SESSION_COOKIE } from './auth.ts';
import { serverConfig } from './config.ts';
import { reconcileSignIn, SelfServeRequest, WorkosOrganizations } from './org-sync.ts';
import { DbSafeInt } from './db.ts';

/** Relying-party settings: the `SANCTUM_OIDC_*` group, all set or not configured. */
export interface SignIn {
  readonly issuer: URL;
  readonly clientId: string;
  /** None: a public client, which always uses PKCE. */
  readonly clientSecret: Option.Option<Redacted.Redacted>;
  /** Exact callback URL registered at the issuer. */
  readonly redirectUri: URL;
  readonly scopes: string;
  /** Replaces network requests to the issuer (tests, the in-process embedded issuer). */
  readonly fetch?: oidc.CustomFetch;
}

export class SignInSettings extends Context.Tag('sanctum/SignInSettings')<
  SignInSettings,
  { readonly client: Option.Option<SignIn>; readonly embeddedIssuer: 'better-auth' | null }
>() {}

/** The sign-in group of `serverConfig`; the issuer string is converted to a URL only for discovery. */
export const SignInFromEnv = Layer.effect(
  SignInSettings,
  Effect.flatMap(serverConfig, ({ signIn, embeddedIssuer }) =>
    Effect.gen(function* () {
      const { issuer, clientId, redirectUri, clientSecret, scopes } = signIn;
      const url = yield* Option.match(issuer, {
        onNone: () => Effect.succeed(Option.none<URL>()),
        onSome: value =>
          Effect.try({
            try: () => Option.some(new URL(value)),
            catch: () => ConfigError.InvalidData([], `SANCTUM_OIDC_ISSUER is not a URL: ${value}`),
          }),
      });
      return {
        client: Option.map(Option.all({ issuer: url, clientId, redirectUri }), group => ({ ...group, clientSecret, scopes })),
        embeddedIssuer: Option.getOrNull(embeddedIssuer),
      };
    }),
  ),
);

/** Random per-attempt values only, so it needs no signing key: `state` and PKCE bind the code to this browser. */
const FLOW_COOKIE = 'sanctum_oidc';
const CSRF_COOKIE = 'sanctum_csrf';
const Flow = Schema.Struct({
  state: Schema.String,
  nonce: Schema.String,
  verifier: Schema.optional(Schema.String),
  intent: Schema.Literal('login', 'link'),
  return_to: Schema.String,
  workspace: Schema.optional(Schema.String),
  /** Self-serve workspace to create when this sign-in finds no membership. */
  create: Schema.optional(SelfServeRequest),
});
type Flow = typeof Flow.Type;
const FlowCookie = Schema.compose(Schema.StringFromBase64Url, Schema.parseJson(Flow));

/** Same-origin path, query and fragment of `value`, else `/`; never an open redirect, so never `//` or `/\` after normalization. */
const localPath = (value: string | null) => {
  const base = 'https://sanctum.invalid';
  const url = new URL(value ?? '/', base);
  const path = `${url.pathname}${url.search}${url.hash}`;
  return value?.startsWith('/') && url.origin === base && !path.startsWith('//') && !path.startsWith('/\\') ? path : '/';
};

/** Ends the callback at `/?signin=<code>`; `reason` goes to the log only. */
class SignInFailed extends Data.TaggedError('SignInFailed')<{
  readonly code: 'failed' | 'not_member' | 'choose_workspace' | 'already_linked' | 'unconfigured';
  readonly reason: string;
  readonly params?: ReadonlyArray<[string, string]>;
}> {}

/** The contract error envelope as a JSON response, for routes mounted outside `SanctumApi`. */
export const errorResponse = (error: Unauthenticated | Forbidden | NotFound | Unavailable) =>
  HttpServerResponse.unsafeJson(error, { status: { Unauthenticated: 401, Forbidden: 403, NotFound: 404, Unavailable: 503 }[error._tag] });

/** Discovery runs once per process; a failed attempt is retried on the next request. */
const relyingParty = (settings: SignIn) => {
  let discovered: Promise<oidc.Configuration> | undefined;
  const configuration = () =>
    (discovered ??= oidc
      .discovery(
        settings.issuer,
        settings.clientId,
        Option.getOrUndefined(Option.map(settings.clientSecret, Redacted.value)),
        Option.isNone(settings.clientSecret) ? oidc.None() : undefined,
        settings.fetch ? { [oidc.customFetch]: settings.fetch } : undefined,
      )
      .catch((error: unknown) => {
        discovered = undefined;
        throw error;
      }));
  return Effect.tryPromise({ try: configuration, catch: () => new Unavailable({ message: 'The sign-in issuer is unreachable', retryable: true }) });
};

const flowCookie = (flow: Flow) =>
  HttpServerResponse.unsafeSetCookie(FLOW_COOKIE, Schema.encodeSync(FlowCookie)(flow), { httpOnly: true, sameSite: 'lax', path: '/auth', maxAge: '10 minutes' });

/** Mounts `/auth/*` (plan sign-in section 4.3) on the API router. */
export const SignInLive = HttpApiBuilder.Router.use(router =>
  Effect.gen(function* () {
    const { client, embeddedIssuer } = yield* SignInSettings;
    const organizations = yield* WorkosOrganizations;
    // WorkOS organizations hold the hosted team; the website's Team overlay runs on them.
    const workos = Option.isSome(client) && Option.isSome(organizations);
    const selfServe = workos && Option.exists(organizations, settings => settings.selfServe);
    const authenticator = yield* Authenticator;
    const sql = yield* SqlClient.SqlClient;
    const party = Option.map(client, settings => ({ settings, configuration: relyingParty(settings) }));
    type Party = Option.Option.Value<typeof party>;

    /** Authorization URL plus the flow it must come back with. */
    const start = ({ settings, configuration }: Party, intent: Flow['intent'], request: HttpServerRequest.HttpServerRequest, create?: SelfServeRequest) =>
      Effect.gen(function* () {
        const config = yield* configuration;
        const query = new URL(request.url, 'http://local').searchParams;
        const workspace = query.get('workspace');
        const verifier = Option.isNone(settings.clientSecret) || config.serverMetadata().supportsPKCE() ? oidc.randomPKCECodeVerifier() : undefined;
        const flow: Flow = {
          state: oidc.randomState(),
          nonce: oidc.randomNonce(),
          intent,
          return_to: localPath(query.get('return_to')),
          ...(verifier === undefined ? {} : { verifier }),
          ...(workspace === null ? {} : { workspace }),
          ...(create === undefined ? {} : { create }),
        };
        const pkce = verifier === undefined ? {} : { code_challenge: yield* Effect.promise(() => oidc.calculatePKCECodeChallenge(verifier)), code_challenge_method: 'S256' };
        const url = oidc.buildAuthorizationUrl(config, { redirect_uri: settings.redirectUri.href, scope: settings.scopes, state: flow.state, nonce: flow.nonce, ...pkce });
        return { url: url.href, flow };
      });

    const login = (identity: { issuer: string; subject: string }, flow: Flow, name: unknown) =>
      Effect.gen(function* () {
        const notMember = (reason: string) => new SignInFailed({ code: 'not_member', reason, params: [['issuer', identity.issuer], ['subject', identity.subject]] });
        yield* reconcileSignIn(identity, typeof name === 'string' ? name : null, flow.create).pipe(
          Effect.provideService(WorkosOrganizations, organizations),
          Effect.catchTag('WorkosFailure', error => new SignInFailed({ code: 'failed', reason: error.message })),
        );
        const principal = yield* identityPrincipal(identity);
        if (Option.isNone(principal)) return yield* notMember('unknown identity');
        const found = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: Schema.Struct({ workspace_id: WorkspaceId, live: DbSafeInt }),
          execute: () => sql`SELECT m.workspace_id, w.deleted_at IS NULL AS live FROM workspace_members m
            JOIN principals p ON p.id = m.principal_id JOIN workspaces w ON w.id = m.workspace_id
            WHERE m.principal_id = ${principal.value} AND m.revoked_at IS NULL AND p.disabled_at IS NULL AND p.kind = 'human' AND ${ownerUntilPurge(sql)}
            AND (${flow.workspace ?? null} IS NULL OR m.workspace_id = ${flow.workspace ?? null}) ORDER BY m.workspace_id`,
        })(undefined).pipe(Effect.catchTag('ParseError', Effect.die));
        const live = found.filter(m => m.live === 1);
        const memberships = live.length > 0 ? live : found;
        if (memberships.length === 0) return yield* notMember('no active human membership');
        if (memberships.length > 1) {
          return yield* new SignInFailed({ code: 'choose_workspace', reason: 'several memberships', params: memberships.map(m => ['workspace', m.workspace_id]) });
        }
        const member = { workspace_id: memberships[0]!.workspace_id, principal_id: principal.value };
        // Plan sign-in section 5.2: the ID token `name` claim, when present and non-empty, refreshes the display name in the session's transaction.
        const session = yield* sql.withTransaction(
          Effect.gen(function* () {
            const opened = yield* openSession(member).pipe(Effect.catchTag('Forbidden', () => notMember('membership ended during sign-in')));
            if (typeof name === 'string' && name.trim() !== '') yield* sql`UPDATE principals SET display_name = ${name.trim().slice(0, 200)} WHERE id = ${principal.value}`;
            return opened;
          }),
        );
        const expires = new Date(session.expires_at);
        return HttpServerResponse.redirect(flow.return_to, { status: 302 }).pipe(
          HttpServerResponse.unsafeSetCookie(SESSION_COOKIE, session.token, { path: '/', httpOnly: true, sameSite: 'lax', expires }),
          HttpServerResponse.unsafeSetCookie(CSRF_COOKIE, session.csrf_token, { path: '/', httpOnly: false, sameSite: 'strict', expires }),
        );
      });

    /** Binds the identity to the principal of the browser session that started the link. */
    const link = (identity: { issuer: string; subject: string }, flow: Flow, request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const access = yield* authenticator.authenticate(request).pipe(Effect.mapError(error => new SignInFailed({ code: 'failed', reason: error.message })));
        if (access.principal.kind !== 'human') return yield* new SignInFailed({ code: 'failed', reason: 'link needs a human session' });
        yield* linkIdentity({ ...identity, principal_id: access.principal.id }).pipe(
          Effect.catchTag('Forbidden', error => new SignInFailed({ code: 'already_linked', reason: error.message })),
        );
        return HttpServerResponse.redirect(flow.return_to, { status: 302 });
      });

    const callback = ({ settings, configuration }: Party, request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const failed = (reason: string) => new SignInFailed({ code: 'failed', reason });
        const flow = yield* Schema.decodeUnknown(FlowCookie)(request.cookies[FLOW_COOKIE]).pipe(Effect.mapError(() => failed('missing or invalid flow cookie')));
        const config = yield* configuration.pipe(Effect.mapError(error => failed(error.message)));
        // The registered URL, not the proxied request URL, so `redirect_uri` matches exactly.
        const current = new URL(settings.redirectUri);
        current.search = new URL(request.url, 'http://local').search;
        const checks = { expectedState: flow.state, expectedNonce: flow.nonce, ...(flow.verifier === undefined ? {} : { pkceCodeVerifier: flow.verifier }) };
        const tokens = yield* Effect.tryPromise({
          try: () => oidc.authorizationCodeGrant(config, current, checks),
          catch: error => failed(error instanceof Error ? error.message : 'token exchange failed'),
        });
        const claims = tokens.claims();
        if (claims === undefined) return yield* failed('no ID token');
        const identity = { issuer: claims.iss, subject: claims.sub };
        return yield* flow.intent === 'link' ? link(identity, flow, request) : login(identity, flow, claims['name']);
      });

    const answer = (error: Unauthenticated | Forbidden | Unavailable) => Effect.succeed(errorResponse(error));
    const unconfigured = errorResponse(new Unavailable({ message: 'No sign-in issuer is configured', retryable: false }));

    yield* router.get(
      '/auth/config',
      Effect.succeed(HttpServerResponse.unsafeJson({ sign_in: Option.isSome(client), embedded_issuer: embeddedIssuer, self_serve_workspaces: selfServe, workos_organizations: workos })),
    );

    yield* router.get(
      '/auth/login',
      Effect.gen(function* () {
        if (Option.isNone(party)) return unconfigured;
        const request = yield* HttpServerRequest.HttpServerRequest;
        // `workspace_name` and `timezone` ask for a self-serve workspace if the sign-in finds no membership.
        const query = new URL(request.url, 'http://local').searchParams;
        const name = query.get('workspace_name');
        let create: SelfServeRequest | undefined;
        if (name !== null) {
          if (!selfServe) return errorResponse(new Forbidden({ message: 'Self-serve workspaces are off' }));
          const decoded = Schema.decodeUnknownOption(SelfServeRequest)({ name, timezone: query.get('timezone') });
          if (Option.isNone(decoded)) return HttpServerResponse.unsafeJson({ message: 'A workspace needs a name of 1 to 200 characters and an IANA time zone' }, { status: 400 });
          create = decoded.value;
        }
        const { url, flow } = yield* start(party.value, 'login', request, create);
        return HttpServerResponse.redirect(url, { status: 302 }).pipe(flowCookie(flow));
      }).pipe(Effect.catchAll(answer)),
    );

    yield* router.post(
      '/auth/link',
      Effect.gen(function* () {
        if (Option.isNone(party)) return unconfigured;
        const request = yield* HttpServerRequest.HttpServerRequest;
        // Cookie mutations need the CSRF header here; a bearer credential is an agent and is refused.
        const access = yield* authenticator.authenticate(request);
        if (access.principal.kind !== 'human') return errorResponse(new Forbidden({ message: 'Linking a sign-in needs a human browser session' }));
        const { url, flow } = yield* start(party.value, 'link', request);
        return HttpServerResponse.unsafeJson({ url }).pipe(flowCookie(flow));
      }).pipe(Effect.catchAll(answer)),
    );

    yield* router.get(
      '/auth/callback',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (Option.isNone(party)) return yield* new SignInFailed({ code: 'unconfigured', reason: 'no sign-in issuer is configured' });
        return yield* callback(party.value, request);
      }).pipe(
        Effect.catchTag('SignInFailed', error =>
          Effect.as(
            Effect.logWarning('Sign-in refused', { code: error.code, reason: error.reason }),
            HttpServerResponse.redirect(`/?${new URLSearchParams([['signin', error.code], ...(error.params ?? [])])}`, { status: 302 }),
          ),
        ),
        Effect.map(HttpServerResponse.expireCookie(FLOW_COOKIE, { path: '/auth' })),
        Effect.orDie,
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
    );

    yield* router.post(
      '/auth/logout',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const access = yield* authenticator.authenticate(request);
        const token = request.cookies[SESSION_COOKIE];
        if (access.principal.kind === 'agent' || token === undefined) return errorResponse(new Forbidden({ message: 'Sign-out needs a browser session' }));
        yield* Effect.provideService(revokeSession(token), SqlClient.SqlClient, sql).pipe(Effect.orDie);
        return HttpServerResponse.empty({ status: 204 }).pipe(
          HttpServerResponse.expireCookie(SESSION_COOKIE, { path: '/' }),
          HttpServerResponse.expireCookie(CSRF_COOKIE, { path: '/', httpOnly: false, sameSite: 'strict' }),
        );
      }).pipe(Effect.catchAll(answer)),
    );
  }),
);
