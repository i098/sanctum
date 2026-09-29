/**
 * Review dialog data read through the same v1 SDK the agents use. Each frame settles on its
 * own: a failing source shows its real error and never blanks or fakes the others.
 */
import {
  type ActionReceipt,
  type ContextEvent,
  type ContextSnapshot,
  type Meeting,
  type MeetingNotes,
  pages,
  type RecordingAccess,
  SanctumError,
  type SanctumClient,
  type SourceRange,
  type TranscriptSegment,
} from '@sanctum/sdk';

export type Frame<A> = { readonly status: 'ok'; readonly data: A } | { readonly status: 'error'; readonly code: string; readonly message: string };

export const settle = <A>(promise: Promise<A>): Promise<Frame<A>> =>
  promise.then(
    data => ({ status: 'ok', data }),
    (error: unknown) =>
      error instanceof SanctumError
        ? { status: 'error', code: error.code, message: error.message }
        : { status: 'error', code: 'network', message: error instanceof Error ? error.message : String(error) },
  );

/** A source still in flight, or how it settled. */
export type Loadable<A> = { readonly status: 'loading' } | Frame<A>;

export interface Review {
  readonly meeting: Meeting;
  readonly notes: Loadable<MeetingNotes>;
  readonly transcript: Loadable<ReadonlyArray<TranscriptSegment>>;
  readonly recording: Loadable<RecordingAccess>;
  readonly context: Loadable<ContextSnapshot>;
  readonly actions: Loadable<ReadonlyArray<ActionReceipt>>;
  readonly changes: Loadable<ReadonlyArray<ContextEvent>>;
}

export type ReviewState = { readonly status: 'loading' } | { readonly status: 'empty' } | Frame<Review>;

const LOADING = { status: 'loading' } as const;

/** Every item of every page, in order. */
async function collect<A, B>(iterable: AsyncIterable<A>, items: (page: A) => ReadonlyArray<B>): Promise<ReadonlyArray<B>> {
  const all: Array<B> = [];
  for await (const page of iterable) all.push(...items(page));
  return all;
}

/**
 * The most recent meeting this caller may read, then each Review source in parallel: `update`
 * receives the new state as every source settles, so one slow source never hides the others.
 * ponytail: reads whole transcripts and feeds page by page; page lazily when meetings outgrow a few thousand segments.
 */
export async function loadReview(client: SanctumClient, signal: AbortSignal, update: (state: ReviewState) => void): Promise<void> {
  const options = { signal };
  const page = await settle(client.meetings.listMeetings({ limit: 1 }, options));
  const meeting = page.status === 'ok' ? page.data.meetings[0] : undefined;
  if (meeting === undefined) return update(page.status === 'error' ? page : { status: 'empty' });
  const meeting_id = meeting.id;
  let review: Review = { meeting, notes: LOADING, transcript: LOADING, recording: LOADING, context: LOADING, actions: LOADING, changes: LOADING };
  update({ status: 'ok', data: review });
  const land = <K extends Exclude<keyof Review, 'meeting'>>(key: K, frame: Promise<Review[K]>) =>
    frame.then(settled => {
      review = { ...review, [key]: settled };
      update({ status: 'ok', data: review });
    });
  await Promise.all([
    land('notes', settle(client.meetings.getNotes({ meeting_id }, options))),
    land('transcript', settle(collect(pages(client, 'meetings.getTranscript', { meeting_id, limit: 200 }, options), next => next.segments))),
    land('recording', settle(client.meetings.recordingAccess({ meeting_id }, options))),
    land('context', settle(client.context.getContext({ meeting_id }, options))),
    land('actions', settle(collect(pages(client, 'actions.listMeetingActions', { meeting_id, limit: 200 }, options), next => next.actions))),
    land('changes', settle(collect(pages(client, 'context.getContextChanges', { meeting_id, limit: 200 }, options), next => next.events))),
  ]);
}

/**
 * Seconds into the recording file where `source` starts, or null when none of it was saved.
 * The file plays `pieces` back to back, so a sample's offset is the saved audio before it.
 */
export function playbackOffset(recording: RecordingAccess, source: SourceRange): number | null {
  let before = 0;
  for (const piece of recording.pieces) {
    const overlaps = piece.epoch_id === source.epoch_id && piece.track === source.track && source.sample_start < piece.sample_end && source.sample_end > piece.sample_start;
    if (overlaps) return (before + Math.max(0, source.sample_start - piece.sample_start)) / recording.sample_rate;
    before += piece.sample_end - piece.sample_start;
  }
  return null;
}
