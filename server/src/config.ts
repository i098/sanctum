/**
 * Process configuration and the plan section 02 engineering defaults.
 * Defaults are acceptance-test inputs and calibration starting points, not measured optima.
 */
import { Config, Effect, Redacted } from 'effect';
import { Unavailable } from '@sanctum/contracts';

/** Plan section 02 "Recommended engineering defaults"; change here, never as scattered literals. */
export const engineeringDefaults = {
  archiveChunkSeconds: 30,
  browserCommitIntervalMs: 2_000,
  heartbeatIntervalMs: 15_000,
  ownershipLeaseMs: 45_000,
  contextJob: { quietPeriodMs: 25_000, turnThreshold: 4 },
  boundaryEvaluationGapMs: 5 * 60_000,
  playbackUrlTtlMs: 5 * 60_000,
  /** No automatic expiry until a retention policy is selected (docs/DECISIONS.md). */
  recordingExpiry: null,
  /**
   * Plan section 09 initial model per role, checked against provider docs on 2026-09-29, plus
   * the Cerebras reasoning effort per role. `<ROLE>_MODEL_PROVIDER` / `<ROLE>_MODEL` override.
   */
  modelRoles: {
    voice: { provider: 'cerebras', model: 'qwen-3.8-27b', reasoning: 'none' },
    extraction: { provider: 'cerebras', model: 'qwen-3.8-27b', reasoning: 'low' },
    planner: { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: null },
    research: { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: null },
  },
  /** Per-attempt timeout, bounded transport attempts, output cap and hosted-search budget. */
  modelRequest: { timeoutMs: 60_000, maxAttempts: 3, maxOutputTokens: 4_096, researchMaxSearches: 5, researchMaxContinuations: 3 },
  /** Integration gateways (plan section 10): model-facing output budget, options page, upstream timeout. */
  pipedream: { outputBudgetBytes: 16_384, optionsPageSize: 20, requestTimeoutMs: 30_000 },
} as const;

export type ModelRoleName = keyof typeof engineeringDefaults.modelRoles;

/** Research needs Anthropic's hosted web search, so only its model is configurable. */
const modelRole = (role: ModelRoleName) => {
  const fallback = engineeringDefaults.modelRoles[role];
  const providers = role === 'research' ? (['anthropic'] as const) : (['cerebras', 'anthropic'] as const);
  const prefix = role.toUpperCase();
  return Config.all({
    provider: Config.literal(...providers)(`${prefix}_MODEL_PROVIDER`).pipe(Config.withDefault(fallback.provider)),
    model: Config.string(`${prefix}_MODEL`).pipe(Config.withDefault(fallback.model)),
    reasoning: Config.succeed(fallback.reasoning),
  });
};

/** Decisions still open in docs/DECISIONS.md; each blocks production activation until selected. */
const openDecisions = ['identity_issuer', 'mcp_authorization_server', 'meeting_retention', 'outside_meeting_speech'] as const;
type OpenDecision = (typeof openDecisions)[number];

const noDecisions: ReadonlyArray<OpenDecision> = [];

const port = (name: string, fallback: number) => Config.port(name).pipe(Config.withDefault(fallback));

export const serverConfig = Config.all({
  environment: Config.literal('development', 'test', 'production')('SANCTUM_ENV').pipe(Config.withDefault('development')),
  apiPort: port('API_PORT', 7102),
  mysql: Config.all({
    host: Config.string('MYSQL_HOST').pipe(Config.withDefault('127.0.0.1')),
    port: port('MYSQL_PORT', 3306),
    database: Config.string('MYSQL_DATABASE').pipe(Config.withDefault('sanctum')),
    username: Config.string('MYSQL_USER').pipe(Config.withDefault('sanctum')),
    password: Config.redacted('MYSQL_PASSWORD').pipe(Config.withDefault(Redacted.make(''))),
    maxConnections: Config.integer('MYSQL_POOL_SIZE').pipe(Config.withDefault(10)),
    queueLimit: Config.integer('MYSQL_POOL_QUEUE').pipe(Config.withDefault(100)),
  }),
  /** Open decisions an operator has explicitly selected and configured, comma-separated. */
  selectedDecisions: Config.array(Config.literal(...openDecisions)(), 'SANCTUM_SELECTED_DECISIONS').pipe(Config.withDefault(noDecisions)),
  modelRoles: Config.all({ voice: modelRole('voice'), extraction: modelRole('extraction'), planner: modelRole('planner'), research: modelRole('research') }),
  /** Absent keys stay absent: calls for that provider fail visibly and no other provider is chosen. */
  modelKeys: Config.all({ cerebras: Config.option(Config.redacted('CEREBRAS_API_KEY')), anthropic: Config.option(Config.redacted('ANTHROPIC_API_KEY')) }),
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
 * Production refuses to start while any open decision is unselected; development and tests
 * run with fixtures. Selecting a decision is an operator action, never a code default.
 */
export const requireActivation = (config: Pick<ServerConfig, 'environment' | 'selectedDecisions'>) => {
  const missing = openDecisions.filter(decision => !config.selectedDecisions.includes(decision));
  return config.environment !== 'production' || missing.length === 0
    ? Effect.void
    : Effect.fail(new Unavailable({ message: `Production activation blocked; unselected: ${missing.join(', ')}`, retryable: false }));
};
