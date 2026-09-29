/** Branded identifiers and scalar wire primitives shared by every slice. */
import { Schema } from 'effect';

const id = <const B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

export const WorkspaceId = id('WorkspaceId');
export type WorkspaceId = typeof WorkspaceId.Type;
export const PrincipalId = id('PrincipalId');
export type PrincipalId = typeof PrincipalId.Type;
export const ProfileId = id('ProfileId');
export type ProfileId = typeof ProfileId.Type;
export const AgentCredentialId = id('AgentCredentialId');
export type AgentCredentialId = typeof AgentCredentialId.Type;
export const ListenerId = id('ListenerId');
export type ListenerId = typeof ListenerId.Type;
export const CaptureEpochId = id('CaptureEpochId');
export type CaptureEpochId = typeof CaptureEpochId.Type;
export const RecordingChunkId = id('RecordingChunkId');
export type RecordingChunkId = typeof RecordingChunkId.Type;
export const ProviderConnectionId = id('ProviderConnectionId');
export type ProviderConnectionId = typeof ProviderConnectionId.Type;
export const TranscriptSegmentId = id('TranscriptSegmentId');
export type TranscriptSegmentId = typeof TranscriptSegmentId.Type;
export const MeetingId = id('MeetingId');
export type MeetingId = typeof MeetingId.Type;
export const SpeakerTrackId = id('SpeakerTrackId');
export type SpeakerTrackId = typeof SpeakerTrackId.Type;
export const ContextItemId = id('ContextItemId');
export type ContextItemId = typeof ContextItemId.Type;
export const ArtifactId = id('ArtifactId');
export type ArtifactId = typeof ArtifactId.Type;
export const IntegrationAccountId = id('IntegrationAccountId');
export type IntegrationAccountId = typeof IntegrationAccountId.Type;
export const ActionGrantId = id('ActionGrantId');
export type ActionGrantId = typeof ActionGrantId.Type;
export const ActionId = id('ActionId');
export type ActionId = typeof ActionId.Type;
export const JobId = id('JobId');
export type JobId = typeof JobId.Type;

/** `unknown`: submitted but outcome ambiguous; never retried automatically before reconciliation. */
export const ActionState = Schema.Literal(
  'proposed',
  'awaiting_authorization',
  'queued',
  'running',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
);
export type ActionState = typeof ActionState.Type;

/** UTC instant with microsecond precision at most, e.g. `2026-09-26T17:08:16.123456Z`. */
export const UtcTimestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/),
  Schema.filter(value => !Number.isNaN(Date.parse(value)) || 'invalid calendar instant'),
  Schema.brand('UtcTimestamp'),
);
export type UtcTimestamp = typeof UtcTimestamp.Type;

const isTimeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** IANA time zone name stored separately from UTC instants. */
export const IanaTimeZone = Schema.String.pipe(
  Schema.filter(zone => zone.includes('/') || zone === 'UTC' ? isTimeZone(zone) : false),
  Schema.brand('IanaTimeZone'),
);
export type IanaTimeZone = typeof IanaTimeZone.Type;

/** Source sample position; JSON numbers are exact only up to 2^53 - 1, so larger values are rejected. */
export const SampleIndex = Schema.Number.pipe(Schema.int(), Schema.nonNegative(), Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const SampleRate = Schema.Literal(8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000);
export type SampleRate = typeof SampleRate.Type;
export const Revision = Schema.Number.pipe(Schema.int(), Schema.positive());
export const Sha256Hex = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
export const IdempotencyKey = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200));

/** Half-open sample interval `[sample_start, sample_end)` on one capture epoch/track. */
export const SourceRange = Schema.Struct({
  epoch_id: CaptureEpochId,
  track: Schema.Number.pipe(Schema.int(), Schema.between(0, 65_535)),
  sample_start: SampleIndex,
  sample_end: SampleIndex,
}).pipe(Schema.filter(range => range.sample_end > range.sample_start || 'sample_end must follow sample_start'));
export type SourceRange = typeof SourceRange.Type;

/** Opaque server-issued pagination/change cursor. */
export const Cursor = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512));
export const PageLimit = Schema.Number.pipe(Schema.int(), Schema.between(1, 200));
