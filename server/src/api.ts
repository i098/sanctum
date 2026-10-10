/**
 * HTTP composition: every group of `SanctumApi` (packages/contracts/src/api.ts) gets its
 * handler layer here. Register a slice with one line in `groups` below.
 */
import { HttpApiBuilder, HttpServerResponse, OpenApi } from '@effect/platform';
import { CurrentAccess } from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Layer } from 'effect';
import { ActionsLive } from './actions.ts';
import { AgentsLive } from './agents.ts';
import { AuthenticatedLive, WorkspaceOwnerLive } from './auth.ts';
import { ContextLive } from './context.ts';
import { HealthLive } from './health.ts';
import { ListenersLive } from './listeners-api.ts';
import { MatchingLive } from './matching.ts';
import { MeetingsLive } from './meetings-api.ts';
import { OnboardingLive } from './onboarding.ts';
import { IntegrationAccountsLive } from './integration-accounts.ts';
import { IntegrationsLive } from './integrations.ts';
import type { Migration } from './migrate.ts';
import { WorkspaceLive } from './workspaces.ts';

/** `GET /api/v1/session` returns the caller's resolved access. Kept here so auth.ts stays below the HTTP contract. */
const SessionLive = HttpApiBuilder.group(SanctumApi, 'session', handlers => handlers.handle('getSession', () => CurrentAccess));

export const ApiLive = (migrations: ReadonlyArray<Migration>) =>
  HttpApiBuilder.api(SanctumApi).pipe(
    Layer.provide([
      HealthLive(migrations),
      SessionLive,
      // Slice handler layers: one line each.
      ListenersLive,
      MeetingsLive,
      ContextLive,
      IntegrationsLive,
      IntegrationAccountsLive,
      ActionsLive,
      MatchingLive,
      AgentsLive,
      WorkspaceLive,
      OnboardingLive,
    ]),
    Layer.provide([AuthenticatedLive, WorkspaceOwnerLive]),
  );

/** The v1 contract the SDKs are generated from (scripts/generate-sdks.ts); operation IDs are `group.endpoint`. */
export const openApiDocument = { ...OpenApi.fromApi(SanctumApi), info: { title: 'Sanctum API', version: 'v1' } };

/** `GET /api/v1/openapi.json`: public, contains no tenant data. */
export const OpenApiLive = HttpApiBuilder.Router.use(router =>
  router.get('/api/v1/openapi.json', HttpServerResponse.json(openApiDocument)),
);
