// stand-in: replaced by the models slice at integration
/** Planner role (docs/ARCHITECTURE.md, models slice). */
import { type AccessScope, type MeetingId, type RequestActionInput, Unavailable } from '@sanctum/contracts';
import { Effect } from 'effect';

/** No planner model is configured: fails visibly instead of inventing a plan. */
export const planActions = (
  _access: AccessScope,
  input: { readonly meeting_id: MeetingId | null; readonly request: string },
): Effect.Effect<ReadonlyArray<typeof RequestActionInput.Type>, Unavailable> =>
  Effect.fail(new Unavailable({ message: `Planner unavailable for request of ${input.request.length} characters`, retryable: false }));
