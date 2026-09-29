// stand-in: replaced by the models slice at integration
import { type CaptureEpochId, type ContextItem, type ExtractionCandidate, type Meeting, type TranscriptSegment, Unavailable, type UtcTimestamp } from '@sanctum/contracts';
import { Effect } from 'effect';
import { LlmClient } from './llm.ts';

/** UTC instant of a capture epoch's first sample (`capture_epochs.sample_start` / `captured_at`). */
export interface EpochAnchor {
  readonly epoch_id: CaptureEpochId;
  readonly sample_rate: number;
  readonly sample_start: number;
  readonly captured_at: UtcTimestamp;
}

export interface ExtractionInput {
  readonly meeting: Meeting;
  readonly segments: ReadonlyArray<TranscriptSegment>;
  readonly snapshot: ReadonlyArray<ContextItem>;
  /** Anchor for every segment's epoch; without one a segment cannot be placed in time and extraction fails. */
  readonly epochs?: ReadonlyArray<EpochAnchor>;
}

/** Structured extraction is not built yet: it reports Unavailable and never invents candidates. */
export const extractCandidates = (_input: ExtractionInput): Effect.Effect<ReadonlyArray<ExtractionCandidate>, Unavailable, LlmClient> =>
  Effect.zipRight(LlmClient, new Unavailable({ message: 'Structured extraction is not available', retryable: true }));
