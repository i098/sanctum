/**
 * HTTP composition: every group of `SanctumApi` (packages/contracts/src/api.ts) gets its
 * handler layer here. Register a slice with one line in `groups` below.
 */
import { HttpApiBuilder, HttpServerResponse, OpenApi } from '@effect/platform';
import { SanctumApi } from '@sanctum/contracts';
import { Layer } from 'effect';
import { StandInGroupsLive } from './api-stand-ins.ts';
import { AuthenticatedLive, SessionLive } from './auth.ts';
import { HealthLive } from './health.ts';
import type { Migration } from './migrate.ts';

export const ApiLive = (migrations: ReadonlyArray<Migration>) =>
  HttpApiBuilder.api(SanctumApi).pipe(
    Layer.provide([
      HealthLive(migrations),
      SessionLive,
      // Slice handler layers: one line each.
      StandInGroupsLive,
    ]),
    Layer.provide(AuthenticatedLive),
  );

/** The v1 contract the SDKs are generated from (scripts/generate-sdks.ts); operation IDs are `group.endpoint`. */
export const openApiDocument = { ...OpenApi.fromApi(SanctumApi), info: { title: 'Sanctum API', version: 'v1' } };

/** `GET /api/v1/openapi.json`: public, contains no tenant data. */
export const OpenApiLive = HttpApiBuilder.Router.use(router =>
  router.get('/api/v1/openapi.json', HttpServerResponse.json(openApiDocument)),
);
