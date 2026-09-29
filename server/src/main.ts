/**
 * API entrypoint: one Node HTTP server for `/api/v1`, health, and (added by their slices)
 * `/mcp`, the live-ingest WebSocket upgrade and built website assets. Accepted durable work
 * belongs to the separate worker entrypoint (worker.ts), never to this process.
 */
import { createServer } from 'node:http';
import { HttpApiBuilder, HttpMiddleware, HttpServer } from '@effect/platform';
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { ApiLive } from './api.ts';
import { type Authenticator, UnconfiguredAuthenticator } from './auth.ts';
import { requireActivation, serverConfig } from './config.ts';
import { dbLayer, type MysqlOptions } from './db.ts';
import { loadMigrations } from './migrate.ts';

/** Process layer: API routes, authentication and database, served on `apiPort` (0 picks a free port). */
export const serverLayer = (
  config: { readonly apiPort: number; readonly mysql: MysqlOptions },
  authenticator: Layer.Layer<Authenticator> = UnconfiguredAuthenticator,
) =>
  HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
    HttpServer.withLogAddress,
    Layer.provide(ApiLive(loadMigrations())),
    Layer.provide(authenticator),
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
