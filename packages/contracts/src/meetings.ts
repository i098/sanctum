/** Meetings, boundary decisions, source ownership ranges and speaker tracks (plan sections 06 and 09). */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { Authenticated } from './auth.ts';
import {
  Cursor,
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
import { MeetingExport, MeetingNotes } from './context.ts';
import { TranscriptSegment } from './transcripts.ts';

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

/** `GET /api/v1/meetings` query: newest first, opaque cursor, bounded limit. */
export const ListMeetingsParams = Schema.Struct({
  state: Schema.optional(MeetingState),
  from: Schema.optional(UtcTimestamp),
  to: Schema.optional(UtcTimestamp),
  /** Meetings with a speaker mapped to this profile. */
  participant: Schema.optional(ProfileId),
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 200))),
});
export type ListMeetingsParams = typeof ListMeetingsParams.Type;

export const MeetingPage = Schema.Struct({ meetings: Schema.Array(Meeting), next_cursor: Schema.NullOr(Cursor) });
export type MeetingPage = typeof MeetingPage.Type;

/** Source position where the later meeting starts; the sample at `sample` belongs to the new meeting. */
export const SplitMeeting = Schema.Struct({
  expected_revision: Revision,
  at: Schema.Struct({ epoch_id: CaptureEpochId, sample: SampleIndex }),
});
export type SplitMeeting = typeof SplitMeeting.Type;

export const SplitResult = Schema.Struct({ earlier: Meeting, later: Meeting });
export type SplitResult = typeof SplitResult.Type;

const RevisionedMeeting = Schema.Struct({ meeting_id: MeetingId, expected_revision: Revision });

/** `source` is folded into `target`; both need matching access before they can merge. */
export const MergeMeetings = Schema.Struct({ target: RevisionedMeeting, source: RevisionedMeeting });
export type MergeMeetings = typeof MergeMeetings.Type;

export const TranscriptParams = Schema.Struct({
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 200))),
});
export type TranscriptParams = typeof TranscriptParams.Type;

/** Latest final segment revisions inside the meeting's current ranges, with the speaker tracks they overlap. */
export const TranscriptPage = Schema.Struct({
  meeting_id: MeetingId,
  boundary_revision: Revision,
  segments: Schema.Array(TranscriptSegment),
  speakers: Schema.Array(SpeakerTrack),
  next_cursor: Schema.NullOr(Cursor),
});
export type TranscriptPage = typeof TranscriptPage.Type;

/** Map (or with `profile_id: null`, unmap) every turn of one provider-local label; checked against its attribution revision. */
export const MapSpeaker = Schema.Struct({
  speaker_track_id: SpeakerTrackId,
  profile_id: Schema.NullOr(ProfileId),
  expected_revision: Revision,
});
export type MapSpeaker = typeof MapSpeaker.Type;

const meetingId = HttpApiSchema.param('meeting_id', MeetingId);

/** Plan section 12 meeting routes; owned by the meetings slice. */
export class MeetingsApi extends HttpApiGroup.make('meetings')
  .add(HttpApiEndpoint.get('listMeetings', '/meetings').setUrlParams(ListMeetingsParams).addSuccess(MeetingPage))
  .add(HttpApiEndpoint.post('mergeMeetings', '/meetings/merge').setPayload(MergeMeetings).addSuccess(Meeting))
  .add(HttpApiEndpoint.get('getMeeting')`/meetings/${meetingId}`.addSuccess(Meeting))
  .add(HttpApiEndpoint.post('closeMeeting')`/meetings/${meetingId}/close`.addSuccess(Meeting))
  .add(HttpApiEndpoint.post('splitMeeting')`/meetings/${meetingId}/split`.setPayload(SplitMeeting).addSuccess(SplitResult))
  .add(HttpApiEndpoint.get('getTranscript')`/meetings/${meetingId}/transcript`.setUrlParams(TranscriptParams).addSuccess(TranscriptPage))
  .add(HttpApiEndpoint.post('recordingAccess')`/meetings/${meetingId}/recording-access`.addSuccess(RecordingAccess))
  .add(HttpApiEndpoint.get('getNotes')`/meetings/${meetingId}/notes`.addSuccess(MeetingNotes))
  .add(HttpApiEndpoint.get('exportMeeting')`/meetings/${meetingId}/export`.addSuccess(MeetingExport))
  .add(HttpApiEndpoint.post('mapSpeaker')`/meetings/${meetingId}/speakers/map`.setPayload(MapSpeaker).addSuccess(Schema.Array(SpeakerTrack)))
  .middleware(Authenticated)
  .prefix('/api/v1') {}
