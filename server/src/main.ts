/**
 * API entrypoint: one Node HTTP server for `/api/v1`, health, and (added by their slices)
 * `/mcp`, the live-ingest WebSocket upgrade and built website assets. Accepted durable work
 * belongs to the separate worker entrypoint (worker.ts), never to this process.
 */
import { createServer } from 'node:http';
import { HttpApiBuilder, HttpMiddleware, HttpServer } from '@effect/platform';
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node';
import { type ConfigError, Effect, Layer } from 'effect';
import { ApiLive } from './api.ts';
import { type Authenticator, UnconfiguredAuthenticator } from './auth.ts';
import { requireActivation, serverConfig } from './config.ts';
import { dbLayer } from './db.ts';
import { ListenerStreamLive } from './media/ingest.ts';
import { loadMigrations } from './migrate.ts';
import type { ObjectStore } from './object-store.ts';
import { DeepgramLive, type SpeechToText } from './providers/deepgram.ts';
import { R2ObjectStoreLive } from './providers/r2.ts';

/** Process layer: API routes, authentication and database, served on `apiPort` (0 picks a free port). */
export const serverLayer = (
  config: { readonly apiPort: number; readonly mysql: Parameters<typeof dbLayer>[0] },
  authenticator: Layer.Layer<Authenticator> = UnconfiguredAuthenticator,
  media: Layer.Layer<ObjectStore | SpeechToText, ConfigError.ConfigError> = Layer.merge(R2ObjectStoreLive, DeepgramLive),
) =>
  HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
    HttpServer.withLogAddress,
    Layer.provide(ListenerStreamLive),
    Layer.provide(ApiLive(loadMigrations())),
    Layer.provide(media),
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
