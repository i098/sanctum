/**
 * The only three integration gateways that enter model context (plan section 10).
 * `action_key` names a catalog operation; `ActionId` names Sanctum's persisted request.
 */
import { Schema } from 'effect';
import { ActionId, IdempotencyKey, IntegrationAccountId, MeetingId } from './common.ts';
import { ActionState } from './actions.ts';

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

export const RequestActionInput = Schema.Struct({
  action_key: ActionKey,
  configuration_ref: Schema.String,
  version: Schema.String,
  arguments: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  meeting_id: Schema.NullOr(MeetingId),
  idempotency_key: IdempotencyKey,
});

export const RequestActionOutput = Schema.Struct({
  action_id: ActionId,
  state: ActionState,
});
