// stand-in: replaced by the pipedream slice at integration
/** Pipedream execution gateway (docs/ARCHITECTURE.md, pipedream slice). */
import type { AccessScope, IntegrationAccountId } from '@sanctum/contracts';
import { Data, Effect } from 'effect';

/** `ambiguous`: the request may have reached the provider, so the outcome is unknown. */
export class IntegrationFailure extends Data.TaggedError('IntegrationFailure')<{
  readonly message: string;
  /** Upstream HTTP status, or null when no response arrived. */
  readonly status: number | null;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
}> {}

/** Nothing is sent: fails definitively until the pipedream slice provides the Connect client. */
export const executeIntegrationAction = (input: {
  readonly access: AccessScope;
  readonly account_id: IntegrationAccountId;
  readonly action_key: string;
  readonly version: string;
  readonly configuration_ref: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly provider_idempotency_key: string | null;
}): Effect.Effect<{ readonly receipt: Record<string, unknown>; readonly artifact: Uint8Array | null }, IntegrationFailure> =>
  Effect.fail(new IntegrationFailure({ message: `Pipedream execution unavailable for ${input.action_key}`, status: null, retryable: false, ambiguous: false }));
