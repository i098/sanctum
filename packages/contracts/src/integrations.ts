/**
 * The only three integration gateways that enter model context (plan section 10).
 * `action_key` names a catalog operation; `ActionId` names Sanctum's persisted request.
 */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { ActionId, IdempotencyKey, IntegrationAccountId, MeetingId } from './common.ts';
import { ActionState } from './actions.ts';
import { Authenticated } from './auth.ts';

export const ActionKey = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255));
export const AppSlug = Schema.String.pipe(Schema.pattern(/^[a-z0-9_-]{1,128}$/));

export const SEARCH_DEFAULT_LIMIT = 3;
export const SEARCH_MAX_LIMIT = 5;

export const SearchIntegrationActionsInput = Schema.Struct({
  intent: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)),
  app: Schema.optional(AppSlug),
  limit: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.between(1, SEARCH_MAX_LIMIT)), {
    default: () => SEARCH_DEFAULT_LIMIT,
  }),
});

/** Compact match: no parameter schemas at search time. */
export const IntegrationActionMatch = Schema.Struct({
  action_key: ActionKey,
  app: AppSlug,
  purpose: Schema.String,
  connection: Schema.Literal('connected', 'not_connected', 'not_permitted'),
  effect: Schema.Literal('read', 'write', 'send', 'delete'),
});

export const SearchIntegrationActionsOutput = Schema.Struct({
  matches: Schema.Array(IntegrationActionMatch).pipe(Schema.maxItems(SEARCH_MAX_LIMIT)),
  refinement_hint: Schema.NullOr(Schema.String),
});

export const GetIntegrationActionInput = Schema.Struct({
  action_key: ActionKey,
  account_id: Schema.optional(IntegrationAccountId),
  configuration: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  field: Schema.optional(Schema.String),
  options_cursor: Schema.optional(Schema.String),
});

/** One selected operation's versioned input requirements; paged and marked incomplete rather than truncated. */
export const GetIntegrationActionOutput = Schema.Struct({
  action_key: ActionKey,
  version: Schema.String,
  configuration_ref: Schema.String,
  fields: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      required: Schema.Boolean,
      description: Schema.NullOr(Schema.String),
      remote_options: Schema.Boolean,
    }),
  ),
  missing: Schema.Array(Schema.String),
  options: Schema.NullOr(
    Schema.Struct({
      field: Schema.String,
      values: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.Unknown })),
      next_cursor: Schema.NullOr(Schema.String),
    }),
  ),
  complete: Schema.Boolean,
});

/** `title`: a short readable name for the request, shown in the listening view's agent-work feed. */
export const RequestActionInput = Schema.Struct({
  action_key: ActionKey,
  configuration_ref: Schema.String,
  version: Schema.String,
  arguments: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  meeting_id: Schema.NullOr(MeetingId),
  idempotency_key: IdempotencyKey,
  title: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(300))),
});

export const RequestActionOutput = Schema.Struct({
  action_id: ActionId,
  state: ActionState,
});

const actionKey = HttpApiSchema.param('action_key', ActionKey);

/** Connector discovery over HTTP (plan section 12); REST, SDKs and MCP share the same gateway functions. */
export class IntegrationsApi extends HttpApiGroup.make('integrations')
  .add(
    HttpApiEndpoint.get('searchIntegrationActions', '/integrations/actions')
      .setUrlParams(
        Schema.Struct({
          ...SearchIntegrationActionsInput.fields,
          limit: Schema.optionalWith(Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, SEARCH_MAX_LIMIT)), { default: () => SEARCH_DEFAULT_LIMIT }),
        }),
      )
      .addSuccess(SearchIntegrationActionsOutput),
  )
  .add(
    HttpApiEndpoint.post('getIntegrationAction')`/integrations/actions/${actionKey}/schema`
      .setPayload(GetIntegrationActionInput.pipe(Schema.omit('action_key')))
      .addSuccess(GetIntegrationActionOutput),
  )
  .middleware(Authenticated)
  .prefix('/api/v1') {}
