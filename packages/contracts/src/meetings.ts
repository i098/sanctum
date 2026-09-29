/** Meetings, boundary decisions, source ownership ranges and speaker tracks (plan sections 06 and 09). */
import { Schema } from 'effect';
import {
  IanaTimeZone,
  MeetingId,
  ProfileId,
  Revision,
  SampleIndex,
  SourceRange,
  SpeakerTrackId,
  CaptureEpochId,
  UtcTimestamp,
  WorkspaceId,
} from './common.ts';

export const MeetingState = Schema.Literal('provisional', 'active', 'closing', 'closed', 'interrupted');
export type MeetingState = typeof MeetingState.Type;

const Progress = Schema.Literal('pending', 'partial', 'complete', 'failed');

/** Processing is tracked per concern; one finishing never implies another. */
export const MeetingProcessing = Schema.Struct({
  transcript: Progress,
  notes: Progress,
  memory: Progress,
  recording: Progress,
});

export const Meeting = Schema.Struct({
  id: MeetingId,
  workspace_id: WorkspaceId,
  state: MeetingState,
  title: Schema.NullOr(Schema.String),
  started_at: UtcTimestamp,
  ended_at: Schema.NullOr(UtcTimestamp),
  timezone: IanaTimeZone,
  boundary_revision: Revision,
  visibility: Schema.Literal('restricted', 'workspace'),
  processing: MeetingProcessing,
});
export type Meeting = typeof Meeting.Type;

/** Half-open source interval owned by one meeting for one boundary revision. */
export const MeetingRange = Schema.Struct({
  meeting_id: MeetingId,
  boundary_revision: Revision,
  source: SourceRange,
});
export type MeetingRange = typeof MeetingRange.Type;

export const BoundaryDecision = Schema.Struct({
  decision: Schema.Literal('continue', 'start', 'close', 'split'),
  source: SourceRange,
  evidence: Schema.Array(Schema.String),
  reason: Schema.String,
  uncertainty: Schema.Number.pipe(Schema.between(0, 1)),
});
export type BoundaryDecision = typeof BoundaryDecision.Type;

/** Provider-local speaker label over a source span; names need enrollment or user confirmation. */
export const SpeakerTrack = Schema.Struct({
  id: SpeakerTrackId,
  epoch_id: CaptureEpochId,
  track: Schema.Number.pipe(Schema.int(), Schema.between(0, 65_535)),
  provider: Schema.String,
  provider_label: Schema.String,
  sample_start: SampleIndex,
  sample_end: SampleIndex,
  profile_id: Schema.NullOr(ProfileId),
  mapping_source: Schema.NullOr(Schema.Literal('enrollment', 'user_confirmed')),
  attribution_revision: Revision,
  confidence: Schema.NullOr(Schema.Number.pipe(Schema.between(0, 1))),
});
export type SpeakerTrack = typeof SpeakerTrack.Type;

/** `POST /api/v1/meetings/{id}/recording-access`: short-lived URL for the current boundary revision's cut. */
export const RecordingAccess = Schema.Struct({
  meeting_id: MeetingId,
  boundary_revision: Revision,
  url: Schema.String,
  expires_at: UtcTimestamp,
  /** Portions of the meeting whose audio is missing (sleep, discard, never uploaded). */
  gaps: Schema.Array(SourceRange),
});
export type RecordingAccess = typeof RecordingAccess.Type;
