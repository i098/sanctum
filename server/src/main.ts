/**
 * API entrypoint: one Node HTTP server for `/api/v1`, health, and (added by their slices)
 * `/mcp`, the live-ingest WebSocket upgrade and built website assets. Accepted durable work
 * belongs to the separate worker entrypoint (worker.ts), never to this process.
 */
import { createServer } from 'node:http';
import { type HttpApi, HttpApiBuilder, HttpMiddleware, HttpServer } from '@effect/platform';
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node';
import type { SqlClient } from '@effect/sql';
import { Effect, Layer } from 'effect';
import { ApiLive, OpenApiLive } from './api.ts';
import { type Authenticator, UnconfiguredAuthenticator } from './auth.ts';
import { requireActivation, serverConfig } from './config.ts';
import { dbLayer } from './db.ts';
import { McpAuthorizationFromEnv, type McpAuthorizationServer, McpLive, withMcpDelegation } from './mcp.ts';
import { loadMigrations } from './migrate.ts';

/** Process layer: API routes, authentication and database, served on `apiPort` (0 picks a free port). */
export const serverLayer = (
  config: { readonly apiPort: number; readonly mysql: Parameters<typeof dbLayer>[0] },
  authenticator: Layer.Layer<Authenticator, never, SqlClient.SqlClient> = UnconfiguredAuthenticator,
  // Tests replace the handler set and the MCP authorization server; production uses the defaults.
  overrides: {
    readonly api?: Layer.Layer<HttpApi.Api, never, SqlClient.SqlClient | Authenticator>;
    readonly mcp?: Layer.Layer<McpAuthorizationServer>;
  } = {},
) =>
  HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
    HttpServer.withLogAddress,
    Layer.provide([McpLive, OpenApiLive]),
    Layer.provide(overrides.api ?? ApiLive(loadMigrations())),
    Layer.provide(withMcpDelegation(authenticator)),
    Layer.provide(overrides.mcp ?? McpAuthorizationFromEnv),
    Layer.provide(dbLayer(config.mysql)),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: config.apiPort, host: '0.0.0.0' })),
  );

if (import.meta.main) {
  Effect.gen(function* () {
    const config = yield* serverConfig;
    yield* requireActivation(config);
    return yield* Layer.launch(serverLayer(config));
  }).pipe(NodeRuntime.runMain);
}
