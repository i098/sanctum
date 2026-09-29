// stand-in: replaced by the models slice at integration
import { type ContextItem, type ExtractionCandidate, type Meeting, type TranscriptSegment, Unavailable } from '@sanctum/contracts';
import { Effect } from 'effect';
import { LlmClient } from './llm.ts';

/** Structured extraction is not built yet: it reports Unavailable and never invents candidates. */
export const extractCandidates = (_input: {
  readonly meeting: Meeting;
  readonly segments: ReadonlyArray<TranscriptSegment>;
  readonly snapshot: ReadonlyArray<ContextItem>;
}): Effect.Effect<ReadonlyArray<ExtractionCandidate>, Unavailable, LlmClient> =>
  Effect.zipRight(LlmClient, new Unavailable({ message: 'Structured extraction is not available', retryable: true }));
