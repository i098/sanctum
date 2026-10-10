/**
 * Settings the image reads (docs/operations.md, server/src/config.ts and the provider adapters).
 * Keys and MySQL/R2 values are Worker secrets; a setting the Worker lacks is not forwarded, so the
 * app keeps its own default and a missing provider key reports that provider as unavailable.
 */
const APP_SETTINGS = [
  'SANCTUM_ENV',
  'SANCTUM_DEFAULT_SEAT_LIMIT',
  'SANCTUM_PAID_RESEARCH_CALLS_PER_DAY',
  'SANCTUM_PAID_RESEARCH_CALLS_PER_DAY_TOTAL',
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
  'OPENAI_API_KEY',
  'CEREBRAS_API_KEY',
  'VOICE_MODEL_PROVIDER',
  'VOICE_MODEL',
  'EXTRACTION_MODEL_PROVIDER',
  'EXTRACTION_MODEL',
  'PLANNER_MODEL_PROVIDER',
  'PLANNER_MODEL',
  'CLASSIFIER_MODEL_PROVIDER',
  'CLASSIFIER_MODEL',
  'RESEARCH_MODEL_PROVIDER',
  'RESEARCH_MODEL',
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
  'WORKOS_API_KEY',
  'SANCTUM_SELF_SERVE_WORKSPACES',
] as const;

export type AppSettings = Partial<Record<(typeof APP_SETTINGS)[number], string>>;

/** The container environment: every app setting the Worker has, and nothing else. */
export const containerEnv = (env: AppSettings): Record<string, string> =>
  Object.fromEntries(APP_SETTINGS.flatMap(name => (env[name] === undefined ? [] : [[name, env[name]]])));

/** The parts of a container Durable Object's state that the start-environment check uses. */
interface ContainerObjectState {
  readonly container?: { readonly running: boolean; destroy(): Promise<void> };
  readonly storage: { get(key: string): Promise<unknown>; put(key: string, value: string): Promise<void> };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

const START_ENV_KEY = 'startEnvHash';

/**
 * A running container keeps the environment it started with; a deploy or secret change does not
 * restart it. Record the SHA-256 of `env` (no values), which the caller's next start passes, then
 * destroy a running container that started with other settings (or before this record existed).
 * The record comes first, so each hash allows at most one destroy even if `running` stays true.
 * Other requests wait.
 */
export const retireStaleContainer = async (state: ContainerObjectState, env: Record<string, string>): Promise<void> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(env)));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  await state.blockConcurrencyWhile(async () => {
    if ((await state.storage.get(START_ENV_KEY)) === hash) return;
    await state.storage.put(START_ENV_KEY, hash);
    if (state.container?.running) await state.container.destroy();
  });
};
