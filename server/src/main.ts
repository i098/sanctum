/**
 * API entrypoint: one Node HTTP server for `/api/v1`, health, built website assets and (added
 * by their slices) `/mcp` and the live-ingest WebSocket upgrade. Accepted durable work
 * belongs to the separate worker entrypoint (worker.ts), never to this process.
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { HttpApiBuilder, HttpMiddleware, HttpServer } from '@effect/platform';
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node';
import { Unavailable } from '@sanctum/contracts';
import { Effect, Layer, flow } from 'effect';
import { ApiLive } from './api.ts';
import { type Authenticator, UnconfiguredAuthenticator } from './auth.ts';
import { requireActivation, serverConfig } from './config.ts';
import { dbLayer } from './db.ts';
import { loadMigrations } from './migrate.ts';
import { secureResponses, webAssetsLive } from './web.ts';

/** `vite build` output; the same relative path from `src/` in the repository and `dist/` in the image. */
const BUILT_WEBSITE = fileURLToPath(new URL('../../web-app/dist/', import.meta.url));

/**
 * Process layer: API routes, authentication and database, served on `apiPort` (0 picks a free
 * port), plus the website from `webRoot` when given.
 */
export const serverLayer = (
  config: { readonly apiPort: number; readonly mysql: Parameters<typeof dbLayer>[0]; readonly webRoot?: string | undefined },
  authenticator: Layer.Layer<Authenticator> = UnconfiguredAuthenticator,
) =>
  HttpApiBuilder.serve(flow(HttpMiddleware.logger, secureResponses)).pipe(
    HttpServer.withLogAddress,
    Layer.provide(config.webRoot === undefined ? Layer.empty : webAssetsLive(config.webRoot)),
    Layer.provide(ApiLive(loadMigrations())),
    Layer.provide(authenticator),
    Layer.provide(dbLayer(config.mysql)),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: config.apiPort, host: '0.0.0.0' })),
  );

if (import.meta.main) {
  Effect.gen(function* () {
    const config = yield* serverConfig;
    yield* requireActivation(config);
    const built = existsSync(BUILT_WEBSITE);
    // Development serves the website from Vite; a production image without its build must not look healthy.
    if (!built && config.environment === 'production') {
      return yield* new Unavailable({ message: `Website build missing at ${BUILT_WEBSITE}`, retryable: false });
    }
    return yield* Layer.launch(serverLayer({ ...config, webRoot: built ? BUILT_WEBSITE : undefined }));
  }).pipe(NodeRuntime.runMain);
}
