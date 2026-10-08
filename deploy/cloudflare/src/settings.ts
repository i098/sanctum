/**
 * Settings the image reads (docs/operations.md, server/src/config.ts and the provider adapters).
 * Keys and MySQL/R2 values are Worker secrets; a setting the Worker lacks is not forwarded, so the
 * app keeps its own default and a missing provider key reports that provider as unavailable.
 */
const APP_SETTINGS = [
  'SANCTUM_ENV',
  'SANCTUM_DEFAULT_SEAT_LIMIT',
  'SANCTUM_SELECTED_DECISIONS',
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_DATABASE',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'MYSQL_CA_CERT',
  'MYSQL_POOL_SIZE',
  'R2_ENDPOINT',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'WORKERS_AI_ACCOUNT_ID',
  'WORKERS_AI_API_TOKEN',
  'ANTHROPIC_API_KEY',
  'VOICE_MODEL_PROVIDER',
  'VOICE_MODEL',
  'EXTRACTION_MODEL_PROVIDER',
  'EXTRACTION_MODEL',
  'PLANNER_MODEL_PROVIDER',
  'PLANNER_MODEL',
  'RESEARCH_MODEL_PROVIDER',
  'RESEARCH_MODEL',
  'CARTESIA_API_KEY',
  'CARTESIA_VOICE_ID',
  'PIPEDREAM_ENVIRONMENT',
  'PIPEDREAM_PROJECT_ID',
  'PIPEDREAM_CLIENT_ID',
  'PIPEDREAM_CLIENT_SECRET',
  'SANCTUM_DIARIZATION',
  'PYANNOTE_API_KEY',
  'SANCTUM_OIDC_ISSUER',
  'SANCTUM_OIDC_CLIENT_ID',
  'SANCTUM_OIDC_CLIENT_SECRET',
  'SANCTUM_OIDC_REDIRECT_URI',
  'SANCTUM_OIDC_SCOPES',
  'SANCTUM_MCP_ISSUER',
  'SANCTUM_MCP_JWKS_URL',
  'SANCTUM_MCP_RESOURCE',
  'SANCTUM_MCP_DEFAULT_SCOPES',
] as const;

export type AppSettings = Partial<Record<(typeof APP_SETTINGS)[number], string>>;

/** The container environment: every app setting the Worker has, and nothing else. */
export const containerEnv = (env: AppSettings): Record<string, string> =>
  Object.fromEntries(APP_SETTINGS.flatMap(name => (env[name] === undefined ? [] : [[name, env[name]]])));
