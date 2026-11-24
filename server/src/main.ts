/**
 * API entrypoint: one Node HTTP server for `/api/v1`, health, built website assets, `/mcp`, the
 * embedded issuer at `/idp` when selected, and the live-ingest WebSocket upgrade. Accepted durable
 * work belongs to the separate worker entrypoint (worker.ts), never to this process.
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { type HttpApi, HttpApiBuilder, HttpMiddleware, HttpServer, HttpServerRequest } from '@effect/platform';
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node';
import type { SqlClient } from '@effect/sql';
import { type ConfigError, Effect, Layer, flow } from 'effect';
import { ApiLive, OpenApiLive } from './api.ts';
import { type Authenticator, KernelAuthenticatorLive } from './auth.ts';
import { requireActivation, serverConfig } from './config.ts';
import { dbLayer, type DbOptions } from './db.ts';
import { embeddedIssuerLive } from './issuer.ts';
import { McpAuthorizationFromEnv, type McpAuthorizationServer, McpLive, withMcpDelegation } from './mcp.ts';
import { ListenerStreamLive } from './media/ingest.ts';
import { MediaProvidersLive, SpeechSynthesizerLive, type SpeechToText } from './media/providers.ts';
import { SpeechRepliesLive, SpeechWorkRequestsLive } from './speech-requests.ts';
import { type LlmClient, LlmLive } from './llm.ts';
import { SignInFromEnv, type SignInSettings, SignInLive } from './signin.ts';
import { loadMigrations } from './migrate.ts';
import { type WorkosOrganizations, WorkosOrganizationsFromEnv } from './org-sync.ts';
import type { ObjectStore } from './providers/object-store.ts';
import { secureResponses, webAssetsLive } from './web.ts';
import { WidgetTokenLive } from './widget-token.ts';

/** `vite build` output; the same relative path from `src/` in the repository and `dist/` in the image. */
const BUILT_WEBSITE = fileURLToPath(new URL('../../web-app/dist/', import.meta.url));

// These URLs can contain the user's pairing code. Do not send them to logs or traces.
const hasPairingCode = ({ url }: HttpServerRequest.HttpServerRequest) =>
  url.startsWith('/pair?') || url.startsWith('/api/v1/device/pending?') || (url.startsWith('/auth/login?') && url.includes('return_to=%2Fpair%3F'));
const requestLogger = HttpMiddleware.make(app => {
  const logged = HttpMiddleware.logger(app);
  return Effect.flatMap(HttpServerRequest.HttpServerRequest, request => hasPairingCode(request) ? app : logged);
});

/**
 * Process layer: API routes, authentication and database, served on `apiPort` (0 picks a free
 * port), plus the website from `webRoot` when given.
 */
export const serverLayer = (
  config: { readonly apiPort: number; readonly db: DbOptions; readonly webRoot?: string | undefined },
  authenticator: Layer.Layer<Authenticator, never, SqlClient.SqlClient> = KernelAuthenticatorLive,
  // Tests replace providers, models, the handler set, the MCP authorization server or the sign-in issuer; production uses the defaults.
  overrides: {
    readonly media?: Layer.Layer<ObjectStore | SpeechToText, ConfigError.ConfigError>;
    readonly api?: Layer.Layer<HttpApi.Api, never, SqlClient.SqlClient | Authenticator>;
    readonly mcp?: Layer.Layer<McpAuthorizationServer>;
    readonly signIn?: Layer.Layer<SignInSettings>;
    readonly organizations?: Layer.Layer<WorkosOrganizations>;
    readonly llm?: Layer.Layer<LlmClient, ConfigError.ConfigError>;
  } = {},
) =>
  HttpApiBuilder.serve(flow(requestLogger, secureResponses)).pipe(
    HttpServer.withLogAddress,
    Layer.provide(config.webRoot === undefined ? Layer.empty : webAssetsLive(config.webRoot)),
    Layer.provide([ListenerStreamLive, McpLive, SignInLive, WidgetTokenLive, OpenApiLive, embeddedIssuerLive(config.db)]),
    Layer.provide([SpeechSynthesizerLive, Layer.merge(SpeechRepliesLive, SpeechWorkRequestsLive).pipe(Layer.provide(overrides.llm ?? LlmLive))]),
    Layer.provide((overrides.api ?? ApiLive(loadMigrations())).pipe(Layer.provide(overrides.llm ?? LlmLive))),
    Layer.provide(overrides.media ?? MediaProvidersLive),
    Layer.provide(withMcpDelegation(authenticator)),
    Layer.provide(overrides.mcp ?? McpAuthorizationFromEnv),
    Layer.provide(overrides.signIn ?? SignInFromEnv),
    Layer.provide(overrides.organizations ?? WorkosOrganizationsFromEnv),
    Layer.provide(dbLayer(config.db)),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: config.apiPort, host: '0.0.0.0' })),
    HttpMiddleware.withTracerDisabledWhen(hasPairingCode),
  );

if (import.meta.main) {
  Effect.gen(function* () {
    const config = yield* serverConfig;
    yield* requireActivation(config);
    // Development serves the website from Vite; the image always contains the build (server/Dockerfile).
    return yield* Layer.launch(serverLayer({ ...config, webRoot: existsSync(BUILT_WEBSITE) ? BUILT_WEBSITE : undefined }));
  }).pipe(NodeRuntime.runMain);
}
