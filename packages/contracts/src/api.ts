/**
 * The one v1 HTTP contract. Server handlers, the OpenAPI document, SDK generation and the
 * MCP adapter all derive from `SanctumApi`. Register a slice's group with one `.add(...)` line.
 */
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from '@effect/platform';
import { Schema } from 'effect';
import { AgentsApi, SessionApi } from './auth.ts';
import { IntegrationsApi } from './integrations.ts';
import { Forbidden, HashConflict, NotFound, RevisionConflict, Unauthenticated, Unavailable } from './errors.ts';
import { MeetingsApi } from './meetings.ts';

/** Process health and dependency readiness without tenant content. */
export class HealthApi extends HttpApiGroup.make('health')
  .add(HttpApiEndpoint.get('healthz', '/healthz').addSuccess(Schema.Struct({ status: Schema.Literal('ok') })))
  .add(HttpApiEndpoint.get('readyz', '/readyz').addSuccess(Schema.Struct({ status: Schema.Literal('ready') }))) {}

export class SanctumApi extends HttpApi.make('sanctum')
  .add(HealthApi)
  .add(SessionApi)
  // Slice groups: one `.add(XApi)` line each, in plan section 12 order.
  .add(MeetingsApi)
  .add(IntegrationsApi)
  .add(AgentsApi)
  .addError(Unauthenticated)
  .addError(Forbidden)
  .addError(NotFound)
  .addError(RevisionConflict)
  .addError(HashConflict)
  .addError(Unavailable) {}
