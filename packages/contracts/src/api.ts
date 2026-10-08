/**
 * The one v1 HTTP contract. Server handlers, the OpenAPI document, SDK generation and the
 * MCP adapter all derive from `SanctumApi`. Register a slice's group with one `.add(...)` line.
 */
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from '@effect/platform';
import { Schema } from 'effect';
import { AgentsApi, Authenticated, SessionApi } from './auth.ts';
import { ListenersApi } from './capture.ts';
import { IntegrationsApi } from './integrations.ts';
import { ContextApi } from './context.ts';
import { ActionsApi } from './actions-api.ts';
import { Forbidden, HashConflict, NotFound, RevisionConflict, Unauthenticated, Unavailable } from './errors.ts';
import { MatchingApi } from './matching.ts';
import { MeetingsApi } from './meetings.ts';
import { WorkspaceApi } from './workspace.ts';

/** Process health and dependency readiness without tenant content. */
export class HealthApi extends HttpApiGroup.make('health')
 .add(HttpApiEndpoint.get('healthz', '/healthz').addSuccess(Schema.Struct({ status: Schema.Literal('ok') })))
 .add(HttpApiEndpoint.get('readyz', '/readyz').addSuccess(Schema.Struct({ status: Schema.Literal('ready') }))) { }

export class SanctumApi extends HttpApi.make('sanctum')
  .add(HealthApi)
  .add(SessionApi)
  // Slice groups: one `.add(XApi)` line each, in plan section 12 order.
  .add(ListenersApi.middleware(Authenticated))
  .add(MeetingsApi)
  .add(ContextApi.middleware(Authenticated))
  .add(IntegrationsApi)
  .add(ActionsApi)
  .add(MatchingApi.middleware(Authenticated))
  .add(AgentsApi)
  .add(WorkspaceApi)
  .addError(Unauthenticated)
  .addError(Forbidden)
  .addError(NotFound)
  .addError(RevisionConflict)
  .addError(HashConflict)
  .addError(Unavailable) {}
