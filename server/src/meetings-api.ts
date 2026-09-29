/** `MeetingsApi` handlers and the meeting transcript view (plan section 12). */
import { HttpApiBuilder } from '@effect/platform';
import { SqlClient, SqlSchema } from '@effect/sql';
import {
  type AccessScope,
  CaptureEpochId,
  CurrentAccess,
  type MeetingId,
  ProviderConnectionId,
  RevisionConflict,
  type SpeakerTrack,
  SpeakerTrackId,
  type TranscriptPage,
  type TranscriptParams,
  type TranscriptSegment,
  TranscriptSegmentId,
  Unavailable,
} from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Effect, Option, Schema } from 'effect';
import { authorizeMeeting, requireScope } from './auth.ts';
import { DbSafeInt, DbUtc } from './db.ts';
import { mergeMeetings, splitMeeting } from './meeting-corrections.ts';
import { currentRanges, dbFailures, selectMeeting } from './meeting-store.ts';
import { closeMeeting, getMeeting, listMeetings } from './meetings.ts';
import { ObjectStore } from './providers/object-store.ts';
import { issueRecordingAccess } from './playback.ts';
import { mapSpeaker, tracksOverlapping } from './speakers.ts';

const SegmentRow = Schema.Struct({
  id: TranscriptSegmentId,
  epoch_id: CaptureEpochId,
  track: Schema.Number,
  sample_start: DbSafeInt,
  sample_end: DbSafeInt,
  text: Schema.String,
  status: Schema.Literal('partial', 'final'),
  revision: DbSafeInt,
  origin: Schema.Literal('live', 'batch', 'correction'),
  provider: Schema.String,
  model: Schema.String,
  provider_connection_id: Schema.NullOr(ProviderConnectionId),
  speaker_label: Schema.NullOr(Schema.String),
  speaker_track_id: Schema.NullOr(SpeakerTrackId),
  confidence: Schema.NullOr(Schema.Number),
  created_at: DbUtc,
});

/**
 * Attributes each segment to the speaker track covering most of it. Overlapping speech (a second
 * track over 30% of the segment) or weak coverage stays unattributed rather than guessed.
 */
const attributeSegments = (segments: ReadonlyArray<TranscriptSegment>, tracks: ReadonlyArray<SpeakerTrack>): Array<TranscriptSegment> =>
  segments.map(segment => {
    if (segment.speaker_track_id !== null) return segment;
    const { epoch_id, track, sample_start, sample_end } = segment.source;
    const shares = tracks
      .filter(candidate => candidate.epoch_id === epoch_id && candidate.track === track)
      .map(candidate => ({ id: candidate.id, share: (Math.min(sample_end, candidate.sample_end) - Math.max(sample_start, candidate.sample_start)) / (sample_end - sample_start) }))
      .filter(candidate => candidate.share > 0)
      .sort((a, b) => b.share - a.share);
    const [best, second] = shares;
    return best !== undefined && best.share >= 0.5 && (second?.share ?? 0) < 0.3 ? { ...segment, speaker_track_id: best.id } : segment;
  });

const TranscriptCursor = Schema.parseJson(Schema.Tuple(Schema.Number, Schema.Number));

/** Latest final revision of each segment starting inside the meeting's current ranges, in source order, with its speakers. */
export const getTranscript = (access: AccessScope, meeting_id: MeetingId, params: TranscriptParams) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* requireScope(access, 'context:read');
    yield* authorizeMeeting(access, meeting_id, 'read');
    const meeting = yield* selectMeeting(access.workspace_id, meeting_id);
    const revision = Option.getOrThrow(meeting).boundary_revision;
    const [cursorRevision, offset] = params.cursor === undefined ? [revision, 0] : yield* Schema.decode(TranscriptCursor)(Buffer.from(params.cursor, 'base64url').toString());
    if (cursorRevision !== revision) return yield* new RevisionConflict({ message: 'Meeting boundaries changed since this cursor was issued', current_revision: revision });
    const ranges = yield* currentRanges(access.workspace_id, meeting_id);
    // ponytail: every page re-reads the whole meeting's segments; switch to a keyset over (range, sample_start) when transcripts reach tens of thousands of segments.
    const all: Array<TranscriptSegment> = [];
    for (const range of ranges) {
      const rows = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: SegmentRow,
        execute: () => sql`SELECT s.id, s.epoch_id, s.track, s.sample_start, s.sample_end, s.text, s.status, s.revision, s.origin, s.provider, s.model,
            s.provider_connection_id, s.speaker_label, s.speaker_track_id, s.confidence, s.created_at
          FROM transcript_segments s WHERE s.workspace_id = ${access.workspace_id} AND s.epoch_id = ${range.epoch_id} AND s.track = ${range.track} AND s.status = 'final'
            AND s.sample_start >= ${range.sample_start} AND s.sample_start < ${range.sample_end}
            AND NOT EXISTS (SELECT 1 FROM transcript_segments n WHERE n.epoch_id = s.epoch_id AND n.track = s.track AND n.sample_start = s.sample_start
              AND n.sample_end = s.sample_end AND n.status = 'final' AND n.revision > s.revision)
          ORDER BY s.sample_start, s.sample_end`,
      })(undefined);
      all.push(...rows.map(({ epoch_id, track, sample_start, sample_end, ...rest }) => ({ ...rest, source: { epoch_id, track, sample_start, sample_end } })));
    }
    const limit = params.limit ?? 100;
    const page = all.slice(offset, offset + limit);
    const tracks = yield* tracksOverlapping(access.workspace_id, page.map(segment => segment.source));
    const segments = attributeSegments(page, tracks);
    const used = new Set(segments.map(segment => segment.speaker_track_id));
    const next_cursor = offset + limit < all.length ? Buffer.from(Schema.encodeSync(TranscriptCursor)([revision, offset + limit])).toString('base64url') : null;
    return { meeting_id, boundary_revision: revision, segments, speakers: tracks.filter(track => used.has(track.id)), next_cursor } satisfies TranscriptPage;
  }).pipe(dbFailures);

export const MeetingsLive = HttpApiBuilder.group(SanctumApi, 'meetings', handlers =>
  handlers
    .handle('listMeetings', ({ urlParams }) => Effect.flatMap(CurrentAccess, access => Effect.zipRight(requireScope(access, 'context:read'), listMeetings(access, urlParams))))
    .handle('getMeeting', ({ path }) => Effect.flatMap(CurrentAccess, access => Effect.zipRight(requireScope(access, 'context:read'), getMeeting(access, path.meeting_id))))
    .handle('closeMeeting', ({ path }) => Effect.flatMap(CurrentAccess, access => closeMeeting(access, path.meeting_id)))
    .handle('splitMeeting', ({ path, payload }) => Effect.flatMap(CurrentAccess, access => splitMeeting(access, path.meeting_id, payload)))
    .handle('mergeMeetings', ({ payload }) => Effect.flatMap(CurrentAccess, access => mergeMeetings(access, payload)))
    .handle('getTranscript', ({ path, urlParams }) => Effect.flatMap(CurrentAccess, access => getTranscript(access, path.meeting_id, urlParams)))
    .handle('recordingAccess', ({ path }) =>
      Effect.flatMap(CurrentAccess, access =>
        Effect.flatMap(Effect.serviceOption(ObjectStore), store =>
          Option.isNone(store)
            ? new Unavailable({ message: 'Recording storage is not configured', retryable: false })
            : Effect.provideService(issueRecordingAccess(access, path.meeting_id), ObjectStore, store.value),
        ),
      ),
    )
    .handle('mapSpeaker', ({ path, payload }) => Effect.flatMap(CurrentAccess, access => mapSpeaker(access, path.meeting_id, payload))),
);
