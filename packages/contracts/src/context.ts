/** Versioned, time-aware, source-linked context (plan sections 08 and 12). */
import { Schema } from 'effect';
import {
  ArtifactId,
  CaptureEpochId,
  ContextItemId,
  Cursor,
  IanaTimeZone,
  IdempotencyKey,
  MeetingId,
  PrincipalId,
  Revision,
  SampleIndex,
  TranscriptSegmentId,
  UtcTimestamp,
} from './common.ts';

export const ContextKind = Schema.Literal(
  'decision',
  'commitment',
  'constraint',
  'project_fact',
  'preference',
  'open_question',
  'research_observation',
);
export type ContextKind = typeof ContextKind.Type;

export const ContextState = Schema.Literal('provisional', 'committed', 'superseded');

/** Spoken facts, model inferences, human corrections and external research stay distinguishable. */
export const Derivation = Schema.Literal('spoken', 'inferred', 'human_correction', 'external');

const Millis = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

export const SegmentSource = Schema.Struct({ segment_id: TranscriptSegmentId, start_ms: Millis, end_ms: Millis });
export const ArtifactSource = Schema.Struct({ artifact_id: ArtifactId });
export const SourceRef = Schema.Union(SegmentSource, ArtifactSource);
export type SourceRef = typeof SourceRef.Type;

/** Relative time resolved against the utterance's event time in its meeting timezone. */
export const TimeExpression = Schema.Struct({
  phrase: Schema.String,
  normalized: Schema.NullOr(UtcTimestamp),
  anchor: UtcTimestamp,
  timezone: IanaTimeZone,
  ambiguous: Schema.Boolean,
});

export const Author = Schema.Struct({
  type: Schema.Literal('human', 'agent', 'system'),
  id: PrincipalId,
});

export const ContextItem = Schema.Struct({
  id: ContextItemId,
  revision: Revision,
  meeting_id: Schema.NullOr(MeetingId),
  kind: ContextKind,
  text: Schema.String,
  state: ContextState,
  derivation: Derivation,
  event_at: Schema.NullOr(UtcTimestamp),
  valid_from: Schema.NullOr(UtcTimestamp),
  valid_until: Schema.NullOr(UtcTimestamp),
  time: Schema.NullOr(TimeExpression),
  author: Author,
  sources: Schema.Array(SourceRef),
  supersedes: Schema.NullOr(Schema.Struct({ id: ContextItemId, revision: Revision })),
  created_at: UtcTimestamp,
});
export type ContextItem = typeof ContextItem.Type;

/** `GET /api/v1/meetings/{id}/context` (see snippets/context-response.json). */
export const ContextSnapshot = Schema.Struct({
  meeting_id: MeetingId,
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  as_of: UtcTimestamp,
  timezone: IanaTimeZone,
  source_watermark: Schema.NullOr(Schema.Struct({ epoch_id: CaptureEpochId, sample_end: SampleIndex })),
  items: Schema.Array(ContextItem),
  changes_cursor: Cursor,
  truncated: Schema.Boolean,
});
export type ContextSnapshot = typeof ContextSnapshot.Type;

/** `POST /api/v1/context/items`; a retried write repeats the same key and payload. */
export const AddContextItem = Schema.Struct({
  meeting_id: Schema.NullOr(MeetingId),
  expected_revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  kind: ContextKind,
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(20_000)),
  sources: Schema.Array(SourceRef).pipe(Schema.minItems(1)),
  idempotency_key: IdempotencyKey,
});
export type AddContextItem = typeof AddContextItem.Type;

export const ContextChangeKind = Schema.Literal(
  'item_added',
  'item_revised',
  'item_superseded',
  'meeting_boundary_changed',
  'access_changed',
);

/** Committed-order change, written in the same transaction as the change itself. */
export const ContextEvent = Schema.Struct({
  seq: Schema.Number.pipe(Schema.int(), Schema.positive()),
  meeting_id: Schema.NullOr(MeetingId),
  item: Schema.NullOr(Schema.Struct({ id: ContextItemId, revision: Revision })),
  change: ContextChangeKind,
  actor: PrincipalId,
  permission_revision: Revision,
  created_at: UtcTimestamp,
});
export type ContextEvent = typeof ContextEvent.Type;

/** Model output from structured extraction; validated against authorized sources before commit. */
export const ExtractionCandidate = Schema.Struct({
  kind: ContextKind,
  text: Schema.String,
  quote: Schema.NullOr(Schema.String),
  derivation: Schema.Literal('spoken', 'inferred'),
  sources: Schema.Array(SegmentSource).pipe(Schema.minItems(1)),
  time: Schema.NullOr(TimeExpression),
});
export type ExtractionCandidate = typeof ExtractionCandidate.Type;
