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
  /** Per-workspace external action submissions per window; more pause the job until the window frees up. */
  actionBudget: { perWindow: 30, windowMs: 60_000 },
  /** Requested speech: open window, quiet time that ends a direct-request turn, echo memory after playback. */
  speech: { windowMs: 30_000, endOfTurnMs: 700, echoTailMs: 1_500 },
  /** No automatic expiry until a retention policy is selected (docs/DECISIONS.md). */
  recordingExpiry: null,
} as const;

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
  /** Requested speech output; without a key and voice, speech fails as unavailable instead of being faked. */
  cartesia: Config.all({
    apiKey: Config.option(Config.redacted('CARTESIA_API_KEY')),
    voiceId: Config.option(Config.string('CARTESIA_VOICE_ID')),
  }),
  /** Open decisions an operator has explicitly selected and configured, comma-separated. */
  selectedDecisions: Config.array(Config.literal(...openDecisions)(), 'SANCTUM_SELECTED_DECISIONS').pipe(Config.withDefault(noDecisions)),
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
