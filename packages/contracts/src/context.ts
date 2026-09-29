/** Versioned, time-aware, source-linked context (plan sections 08 and 12). */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import {
  ArtifactId,
  CaptureEpochId,
  ContextItemId,
  Cursor,
  IanaTimeZone,
  IdempotencyKey,
  MeetingId,
  PageLimit,
  PrincipalId,
  Revision,
  SampleIndex,
  Sha256Hex,
  SourceRange,
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
export type ContextChangeKind = typeof ContextChangeKind.Type;

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

/** `PATCH /api/v1/context/items/{id}`: a new immutable revision; `state: superseded` retracts the item. */
export const ReviseContextItem = Schema.Struct({
  expected_revision: Revision,
  idempotency_key: IdempotencyKey,
  kind: Schema.optional(ContextKind),
  text: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(20_000))),
  sources: Schema.optional(Schema.Array(SourceRef).pipe(Schema.minItems(1))),
  state: Schema.optional(Schema.Literal('committed', 'superseded')),
});
export type ReviseContextItem = typeof ReviseContextItem.Type;

/** `GET /api/v1/context/changes`: committed-order events after an access-bound cursor. */
export const ContextChanges = Schema.Struct({ events: Schema.Array(ContextEvent), next_cursor: Cursor });
export type ContextChanges = typeof ContextChanges.Type;

/** `GET /api/v1/sources/{id}`: exact cited evidence, readable only within the source's own access scope. */
export const Source = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('segment'),
    id: TranscriptSegmentId,
    meeting_id: MeetingId,
    text: Schema.String,
    revision: Revision,
    speaker_label: Schema.NullOr(Schema.String),
    source: SourceRange,
    event_at: UtcTimestamp,
    start_ms: Schema.Number,
    end_ms: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal('artifact'),
    id: ArtifactId,
    meeting_id: Schema.NullOr(MeetingId),
    title: Schema.String,
    content_type: Schema.String,
    content: Schema.NullOr(Schema.String),
    sha256: Sha256Hex,
    created_at: UtcTimestamp,
  }),
);
export type Source = typeof Source.Type;

const meetingId = HttpApiSchema.param('meeting_id', MeetingId);
const itemId = HttpApiSchema.param('item_id', ContextItemId);
const sourceId = HttpApiSchema.param('source_id', Schema.UUID);
const Limit = Schema.NumberFromString.pipe(Schema.compose(PageLimit));

/** Plan section 12 context routes; api.ts registers the group behind `Authenticated`. */
export class ContextApi extends HttpApiGroup.make('context')
  .add(HttpApiEndpoint.get('getContext')`/meetings/${meetingId}/context`.addSuccess(ContextSnapshot))
  .add(
    HttpApiEndpoint.get('searchContext', '/context/search')
      .setUrlParams(Schema.Struct({ q: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)), meeting_id: Schema.optional(MeetingId), limit: Schema.optional(Limit) }))
      .addSuccess(Schema.Struct({ items: Schema.Array(ContextItem) })),
  )
  .add(HttpApiEndpoint.post('addContextItem', '/context/items').setPayload(AddContextItem).addSuccess(ContextItem, { status: 201 }))
  .add(HttpApiEndpoint.patch('reviseContextItem')`/context/items/${itemId}`.setPayload(ReviseContextItem).addSuccess(ContextItem))
  .add(
    HttpApiEndpoint.get('getContextChanges', '/context/changes')
      .setUrlParams(Schema.Struct({ cursor: Schema.optional(Cursor), meeting_id: Schema.optional(MeetingId), limit: Schema.optional(Limit) }))
      .addSuccess(ContextChanges),
  )
  .add(HttpApiEndpoint.get('getSource')`/sources/${sourceId}`.addSuccess(Source))
  .prefix('/api/v1') {}

/**
 * The one canonical structured summary of a closed meeting (plan sections 08 and 09). Notes,
 * email discussion sections and exports all render from it; every point cites final segments.
 */
export const MeetingNotes = Schema.Struct({
  meeting_id: MeetingId,
  /** Increments each time notes are regenerated (close, boundary or attribution corrections). */
  revision: Revision,
  boundary_revision: Revision,
  model: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  sections: Schema.Array(Schema.Struct({ heading: Schema.String, points: Schema.Array(Schema.Struct({ text: Schema.String, sources: Schema.Array(SegmentSource) })) })),
  generated_at: UtcTimestamp,
});
export type MeetingNotes = typeof MeetingNotes.Type;

/** A rendered export of the canonical notes; `content` is Markdown with source timestamps. */
export const MeetingExport = Schema.Struct({
  meeting_id: MeetingId,
  notes_revision: Revision,
  format: Schema.Literal('markdown'),
  filename: Schema.String,
  content: Schema.String,
});
export type MeetingExport = typeof MeetingExport.Type;

