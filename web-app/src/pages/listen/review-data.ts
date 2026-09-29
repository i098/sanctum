/**
 * Data for the Review dialog's six frames (plan section 14), read through the same v1 SDK the
 * agents use. Each frame settles on its own: one failing source shows its real error and never
 * blanks, fakes or delays the others.
 */
import { type ContextItem, type ContextSnapshot, type SanctumClient, SanctumError } from '@sanctum/sdk';

export type Frame<A> = { readonly status: 'ok'; readonly data: A } | { readonly status: 'error'; readonly code: string; readonly message: string };

export interface ReviewData {
  /** Decisions, commitments and open questions, each linked to its cited sources. */
  readonly notes: Frame<Record<'decision' | 'commitment' | 'open_question', ReadonlyArray<ContextItem>>>;
  readonly transcript: Frame<Awaited<ReturnType<SanctumClient['meetings']['getTranscript']>>>;
  readonly recording: Frame<Awaited<ReturnType<SanctumClient['meetings']['recordingAccess']>>>;
  /** Committed memory only; provisional items stay in Context. */
  readonly memory: Frame<ReadonlyArray<ContextItem>>;
  readonly context: Frame<ContextSnapshot>;
  readonly activity: Frame<Awaited<ReturnType<SanctumClient['context']['getContextChanges']>>>;
}

const settle = <A>(promise: Promise<A>): Promise<Frame<A>> =>
  promise.then(
    data => ({ status: 'ok', data }),
    (error: unknown) =>
      error instanceof SanctumError
        ? { status: 'error', code: error.code, message: error.message }
        : { status: 'error', code: 'network', message: error instanceof Error ? error.message : String(error) },
  );

export async function loadReview(client: SanctumClient, meeting_id: string, signal?: AbortSignal): Promise<ReviewData> {
  const options = signal ? { signal } : {};
  const snapshot = client.context.getContext({ meeting_id }, options);
  const [context, transcript, recording, activity] = await Promise.all([
    settle(snapshot),
    settle(client.meetings.getTranscript({ meeting_id, limit: 200 }, options)),
    settle(client.meetings.recordingAccess({ meeting_id }, options)),
    settle(client.context.getContextChanges({ meeting_id, limit: 50 }, options)),
  ]);
  if (context.status === 'error') return { notes: context, transcript, recording, memory: context, context, activity };
  const items = context.data.items;
  const notes = {
    decision: items.filter(item => item.kind === 'decision'),
    commitment: items.filter(item => item.kind === 'commitment'),
    open_question: items.filter(item => item.kind === 'open_question'),
  };
  return {
    notes: { status: 'ok', data: notes },
    transcript,
    recording,
    memory: { status: 'ok', data: items.filter(item => item.state === 'committed') },
    context,
    activity,
  };
}
