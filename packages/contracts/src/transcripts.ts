/** Transcript segments: immutable source ranges with ASR provenance and revisions. */
import { Schema } from 'effect';
import { ProviderConnectionId, Revision, SourceRange, SpeakerTrackId, TranscriptSegmentId, UtcTimestamp } from './common.ts';

export const TranscriptSource = Schema.Literal('live', 'batch', 'correction');

export const TranscriptSegment = Schema.Struct({
  id: TranscriptSegmentId,
  source: SourceRange,
  text: Schema.String,
  status: Schema.Literal('partial', 'final'),
  revision: Revision,
  origin: TranscriptSource,
  provider: Schema.String,
  model: Schema.String,
  provider_connection_id: Schema.NullOr(ProviderConnectionId),
  /** Provider-local label; never an identity across provider streams. */
  speaker_label: Schema.NullOr(Schema.String),
  speaker_track_id: Schema.NullOr(SpeakerTrackId),
  confidence: Schema.NullOr(Schema.Number.pipe(Schema.between(0, 1))),
  created_at: UtcTimestamp,
});
export type TranscriptSegment = typeof TranscriptSegment.Type;
