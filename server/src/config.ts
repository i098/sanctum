/**
 * Process configuration and the plan section 02 engineering defaults.
 * Defaults are acceptance-test inputs and calibration starting points, not measured optima.
 */
import { Config, Effect, Option, Redacted, Schema } from 'effect';
import { AccessScopeName, type JobKind, Unavailable } from '@sanctum/contracts';

/** Plan section 02 "Recommended engineering defaults"; change here, never as scattered literals. */
export const engineeringDefaults = {
  archiveChunkSeconds: 30,
  browserCommitIntervalMs: 2_000,
  heartbeatIntervalMs: 15_000,
  ownershipLeaseMs: 45_000,
  contextJob: { quietPeriodMs: 25_000, turnThreshold: 4 },
  boundaryEvaluationGapMs: 5 * 60_000,
  playbackUrlTtlMs: 5 * 60_000,
  /** Per-workspace external action submissions per window; more pause the job until the window frees up. */
  actionBudget: { perWindow: 30, windowMs: 60_000 },
  /** No provider answer within this after submission: record `unknown` now; a later answer still settles it. */
  actionSubmitTimeoutMs: 30_000,
  /**
   * Per-attempt handler ceiling; a hit fails the attempt retryably. Calibration inputs, not
   * measured optima. `action.execute` stays above `actionSubmitTimeoutMs` so the executor's own
   * ambiguous-outcome path answers first.
   */
  jobs: {
    ceilingMs: 5 * 60_000,
    ceilingByKind: {
      'recording.assemble': 30 * 60_000,
      'transcript.reconcile': 20 * 60_000,
      /** Above pyannote's poll budget (maxPolls × pollIntervalMs = 10 min) plus audio preparation. */
      'speakers.refine': 20 * 60_000,
      /** Above one research call with transport retries (3 × 4 min) plus planning. */
      'research.run': 20 * 60_000,
      /** Object deletes are idempotent, so a hit keeps its progress and the next attempt continues. */
      'workspace.purge': 30 * 60_000,
    } as Partial<Record<JobKind, number>>,
    /** A purge outlasts an R2 outage of hours instead of failing after five quick retries. */
    purgeMaxAttempts: 50,
  },
  /**
   * Live speech-to-text. Whisper is batch-only, so live audio goes out in chunks cut at the
   * quietest 20 ms between `minMs` and `maxMs` (measured in docs/DECISIONS.md), with at most
   * `concurrency` requests in flight; results still arrive in audio order. Audio without 100 ms in
   * a row at `speechFloorRms` (PCM16 RMS, about -56 dBFS) is never sent. A 429 pauses
   * requests for its Retry-After, else `rateLimitBackoffMs`, and the chunks meanwhile are skipped.
   */
  liveAsr: { minMs: 1_500, maxMs: 2_500, concurrency: 3, requestTimeoutMs: 60_000, speechFloorRms: 50, rateLimitBackoffMs: 30_000 },
  /**
   * Requested speech: open window, quiet audio that ends a direct-request turn, and echo memory
   * after playback. Finals arrive once per live chunk, so a turn waits `turnWaitMs` for the next
   * chunk's finals before it ends, and echo memory outlasts one chunk and its request.
   */
  speech: { windowMs: 30_000, endOfTurnMs: 700, turnWaitMs: 5_000, echoTailMs: 5_000 },
  /** No automatic expiry until a retention policy is selected (docs/DECISIONS.md). */
  recordingExpiry: null,
  /**
   * Plan section 09 initial model per role, checked against provider docs on 2026-10-08, plus
   * the reasoning effort per role (`none` disables it). `<ROLE>_MODEL_PROVIDER` / `<ROLE>_MODEL` override.
   */
  modelRoles: {
    voice: { provider: 'workers-ai', model: '@cf/qwen/qwen3.8-27b', reasoning: 'none' },
    extraction: { provider: 'workers-ai', model: '@cf/qwen/qwen3.8-27b', reasoning: 'low' },
    planner: { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: null },
    research: { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: null },
  },
  /** Per-attempt timeout, bounded transport attempts, output cap and hosted-search budget. */
  modelRequest: { timeoutMs: 60_000, maxAttempts: 3, maxOutputTokens: 4_096, researchMaxSearches: 5, researchMaxContinuations: 3 },
  /** Integration gateways (plan section 10): model-facing output budget, options page, upstream timeout. */
  pipedream: { outputBudgetBytes: 16_384, optionsPageSize: 20, requestTimeoutMs: 30_000 },
  /** WorkOS Events API polling (`workos.sync`): time between runs, pages read per run, request timeout. */
  workosSync: { intervalMs: 60_000, pagesPerRun: 10, requestTimeoutMs: 30_000 },
} as const;

export type ModelRoleName = keyof typeof engineeringDefaults.modelRoles;

/** Research needs Anthropic's hosted web search, so only its model is configurable. */
const modelRole = (role: ModelRoleName) => {
  const fallback = engineeringDefaults.modelRoles[role];
  const providers = role === 'research' ? (['anthropic'] as const) : (['workers-ai', 'anthropic'] as const);
  const prefix = role.toUpperCase();
  return Config.all({
    provider: Config.literal(...providers)(`${prefix}_MODEL_PROVIDER`).pipe(Config.withDefault(fallback.provider)),
    model: Config.string(`${prefix}_MODEL`).pipe(Config.withDefault(fallback.model)),
    reasoning: Config.succeed(fallback.reasoning),
  });
};

/** Decisions in docs/DECISIONS.md an operator lists in `SANCTUM_SELECTED_DECISIONS`; each unlisted one blocks production. */
const activationDecisions = ['identity_issuer', 'mcp_authorization_server', 'meeting_retention', 'outside_meeting_speech'] as const;
type ActivationDecision = (typeof activationDecisions)[number];

const noDecisions: ReadonlyArray<ActivationDecision> = [];

/** Delegated MCP tokens; the issuer is compared with the token `iss` exactly, so kept as written. */
export const mcpAuthorizationConfig = Config.all({
  resource: Config.option(Config.url('SANCTUM_MCP_RESOURCE')),
  issuer: Config.option(Config.string('SANCTUM_MCP_ISSUER')),
  jwksUrl: Config.option(Config.url('SANCTUM_MCP_JWKS_URL')),
  /** Granted only to verified tokens that carry no Sanctum scope name; empty fails closed. */
  defaultScopes: Config.array(Config.literal(...AccessScopeName.literals)(), 'SANCTUM_MCP_DEFAULT_SCOPES').pipe(
    Config.withDefault([] as ReadonlyArray<AccessScopeName>),
  ),
});

const port = (name: string, fallback: number) => Config.port(name).pipe(Config.withDefault(fallback));

/** `SANCTUM_DEFAULT_SEAT_LIMIT`: a positive integer; absent means no limit. A workspace's own `seat_limit` overrides it. */
export const defaultSeatLimit: Config.Config<number | null> = Schema.Config('SANCTUM_DEFAULT_SEAT_LIMIT', Schema.NumberFromString.pipe(Schema.int(), Schema.positive())).pipe(
  Config.option,
  Config.map(Option.getOrNull),
);

/** Days between deleting a workspace and purging its recordings and rows; the owner can undo until then. */
export const workspacePurgeGraceDays = Config.integer('SANCTUM_WORKSPACE_PURGE_GRACE_DAYS').pipe(
  Config.validate({ message: 'must be at least 1 day', validation: days => days >= 1 }),
  Config.withDefault(7),
);

export const serverConfig = Config.all({
  environment: Config.literal('development', 'test', 'production')('SANCTUM_ENV').pipe(Config.withDefault('development')),
  /** Default seat limit; null is unlimited. Read here so a malformed value fails at startup. */
  seatLimit: defaultSeatLimit,
  workspacePurgeGraceDays,
  apiPort: port('API_PORT', 7102),
  mysql: Config.all({
    host: Config.string('MYSQL_HOST').pipe(Config.withDefault('127.0.0.1')),
    port: port('MYSQL_PORT', 3306),
    database: Config.string('MYSQL_DATABASE').pipe(Config.withDefault('sanctum')),
    username: Config.string('MYSQL_USER').pipe(Config.withDefault('sanctum')),
    password: Config.redacted('MYSQL_PASSWORD').pipe(Config.withDefault(Redacted.make(''))),
    maxConnections: Config.integer('MYSQL_POOL_SIZE').pipe(Config.withDefault(10)),
    queueLimit: Config.integer('MYSQL_POOL_QUEUE').pipe(Config.withDefault(100)),
    /** PEM CA certificate; when set, connections require TLS verified against it, host name included. */
    caCert: Config.option(Config.string('MYSQL_CA_CERT')).pipe(Config.map(Option.getOrUndefined)),
  }),
  /** Requested speech output; without a key and voice, speech fails as unavailable instead of being faked. */
  cartesia: Config.all({
    apiKey: Config.option(Config.redacted('CARTESIA_API_KEY')),
    voiceId: Config.option(Config.string('CARTESIA_VOICE_ID')),
  }),
  /** Decisions an operator has explicitly selected and configured, comma-separated. */
  selectedDecisions: Config.array(Config.literal(...activationDecisions)(), 'SANCTUM_SELECTED_DECISIONS').pipe(Config.withDefault(noDecisions)),
  /** Human login with any standard OIDC issuer: WorkOS AuthKit hosted, embedded Better Auth self-hosted. */
  signIn: Config.all({
    /** Compared with the ID token `iss` exactly, so kept as written. */
    issuer: Config.option(Config.string('SANCTUM_OIDC_ISSUER')),
    clientId: Config.option(Config.string('SANCTUM_OIDC_CLIENT_ID')),
    /** Unset means a public client, which must use PKCE. */
    clientSecret: Config.option(Config.redacted('SANCTUM_OIDC_CLIENT_SECRET')),
    redirectUri: Config.option(Config.url('SANCTUM_OIDC_REDIRECT_URI')),
    scopes: Config.string('SANCTUM_OIDC_SCOPES').pipe(Config.withDefault('openid profile email')),
  }),
  mcpAuthorization: mcpAuthorizationConfig,
  /** `better-auth` serves the OIDC issuer and MCP authorization server in-process at `/idp`. */
  embeddedIssuer: Config.option(Config.literal('better-auth')('SANCTUM_EMBEDDED_ISSUER')),
  betterAuthSecret: Config.option(Config.redacted('BETTER_AUTH_SECRET')),
  /** WorkOS Organizations sync (hosted): server-only API key; without it no organization is read or created. */
  workos: Config.all({
    apiKey: Config.option(Config.redacted('WORKOS_API_KEY')),
    /** A signed-in user with no membership may create a workspace (with a WorkOS organization). */
    selfServeWorkspaces: Config.boolean('SANCTUM_SELF_SERVE_WORKSPACES').pipe(Config.withDefault(false)),
  }),
  modelRoles: Config.all({ voice: modelRole('voice'), extraction: modelRole('extraction'), planner: modelRole('planner'), research: modelRole('research') }),
  /** Absent keys stay absent: calls for that provider fail visibly and no other provider is chosen. */
  modelKeys: Config.all({ anthropic: Config.option(Config.redacted('ANTHROPIC_API_KEY')) }),
  /** Cloudflare Workers AI REST base for this account and a token with only Workers AI permission: speech-to-text and the voice and extraction models. */
  workersAi: Config.option(
    Config.all({
      baseUrl: Config.string('WORKERS_AI_ACCOUNT_ID').pipe(Config.map(account => `https://api.cloudflare.com/client/v4/accounts/${account}/ai`)),
      apiToken: Config.redacted('WORKERS_AI_API_TOKEN'),
    }),
  ),
  /** Pipedream Connect; without credentials every integration call fails as `Unavailable`. */
  pipedream: Config.all({
    apiUrl: Config.string('PIPEDREAM_API_URL').pipe(Config.withDefault('https://api.pipedream.com')),
    environment: Config.literal('development', 'production')('PIPEDREAM_ENVIRONMENT').pipe(Config.withDefault('development')),
    credentials: Config.option(
      Config.all({
        projectId: Config.string('PIPEDREAM_PROJECT_ID'),
        clientId: Config.string('PIPEDREAM_CLIENT_ID'),
        clientSecret: Config.redacted('PIPEDREAM_CLIENT_SECRET'),
      }),
    ),
  }),
});
export type ServerConfig = Config.Config.Success<typeof serverConfig>;

/**
 * A listed decision with missing settings is an operator error in every environment. Production
 * also refuses to start while any decision is unlisted; development and tests run with fixtures.
 * Selecting a decision is an operator action, never a code default.
 */
export const requireActivation = (
  config: Pick<ServerConfig, 'environment' | 'selectedDecisions' | 'signIn' | 'mcpAuthorization' | 'embeddedIssuer' | 'betterAuthSecret'>,
) => {
  /** Settings a listed decision needs before it counts as selected; the other decisions have none. */
  const settings: Partial<Record<ActivationDecision, Record<string, Option.Option<unknown>>>> = {
    identity_issuer: {
      SANCTUM_OIDC_ISSUER: config.signIn.issuer,
      SANCTUM_OIDC_CLIENT_ID: config.signIn.clientId,
      SANCTUM_OIDC_REDIRECT_URI: config.signIn.redirectUri,
      ...(Option.isSome(config.embeddedIssuer) ? { BETTER_AUTH_SECRET: config.betterAuthSecret } : {}),
    },
    mcp_authorization_server: {
      SANCTUM_MCP_RESOURCE: config.mcpAuthorization.resource,
      SANCTUM_MCP_ISSUER: config.mcpAuthorization.issuer,
      SANCTUM_MCP_JWKS_URL: config.mcpAuthorization.jwksUrl,
    },
  };
  const incomplete = config.selectedDecisions.flatMap(decision => {
    const unset = Object.entries(settings[decision] ?? {}).flatMap(([name, value]) => (Option.isNone(value) ? [name] : []));
    return unset.length === 0 ? [] : [`${decision} needs ${unset.join(', ')}`];
  });
  if (incomplete.length > 0) return Effect.fail(new Unavailable({ message: `Selected decisions are not configured: ${incomplete.join('; ')}`, retryable: false }));
  const missing = activationDecisions.filter(decision => !config.selectedDecisions.includes(decision));
  return config.environment !== 'production' || missing.length === 0
    ? Effect.void
    : Effect.fail(new Unavailable({ message: `Production activation blocked; unselected: ${missing.join(', ')}`, retryable: false }));
};
