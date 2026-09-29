/** Stored grants, persisted action requests and truthful receipts (plan section 10). */
import { Schema } from 'effect';
import {
  ActionGrantId,
  ActionId,
  IntegrationAccountId,
  MeetingId,
  PrincipalId,
  Revision,
  Sha256Hex,
  UtcTimestamp,
} from './common.ts';

/** `unknown`: submitted but outcome ambiguous; never retried automatically before reconciliation. */
export const ActionState = Schema.Literal(
  'proposed',
  'awaiting_authorization',
  'queued',
  'running',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
);
export type ActionState = typeof ActionState.Type;

/** Created by an authorized human; a prompt can never create one. */
export const ActionGrant = Schema.Struct({
  id: ActionGrantId,
  owner: PrincipalId,
  grantee: PrincipalId,
  action_key: Schema.String,
  app: Schema.String,
  account_id: IntegrationAccountId,
  meeting_id: Schema.NullOr(MeetingId),
  /** Exact resource/recipient restrictions, e.g. `{ "to": ["a@example.com"] }`. */
  restrictions: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  expires_at: Schema.NullOr(UtcTimestamp),
  revoked_at: Schema.NullOr(UtcTimestamp),
  version: Revision,
});
export type ActionGrant = typeof ActionGrant.Type;

export const ActionReceipt = Schema.Struct({
  action_id: ActionId,
  action_key: Schema.String,
  meeting_id: Schema.NullOr(MeetingId),
  state: ActionState,
  args_sha256: Sha256Hex,
  grant: Schema.NullOr(Schema.Struct({ id: ActionGrantId, version: Revision })),
  /** Provider's own receipt/artifact reference, stored separately from model summaries. */
  provider_receipt: Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  attempts: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  reconciliation: Schema.Literal('none', 'pending', 'reconciled'),
  updated_at: UtcTimestamp,
});
export type ActionReceipt = typeof ActionReceipt.Type;

/**
 * Grant input from an authorized human who owns `account_id`. Each restriction key lists the
 * only values the same-named argument may take, e.g. `{ "to": ["a@example.com"] }`.
 */
export const CreateActionGrantInput = Schema.Struct({
  grantee: PrincipalId,
  action_key: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255)),
  account_id: IntegrationAccountId,
  meeting_id: Schema.NullOr(MeetingId),
  restrictions: Schema.Record({ key: Schema.String, value: Schema.Array(Schema.Unknown) }),
  expires_at: Schema.NullOr(UtcTimestamp),
});
export type CreateActionGrantInput = typeof CreateActionGrantInput.Type;

/** Human resolution of an `unknown` action after checking the provider; never inferred automatically. */
export const ResolveActionInput = Schema.Struct({
  outcome: Schema.Literal('succeeded', 'failed'),
  provider_receipt: Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type ResolveActionInput = typeof ResolveActionInput.Type;
