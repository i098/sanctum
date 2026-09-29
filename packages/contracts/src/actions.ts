/** Stored grants, persisted action requests and truthful receipts (plan section 10). */
import { Schema } from 'effect';
import {
  ActionGrantId,
  ActionId,
  ActionState,
  IntegrationAccountId,
  MeetingId,
  PrincipalId,
  Revision,
  Sha256Hex,
  UtcTimestamp,
} from './common.ts';

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
