/**
 * Structured, correctable speaker attribution (plan section 09, T14). Provider-local labels are
 * stored per provider connection with source sample spans; names come only from explicit
 * enrollment matches or user-confirmed mappings, and every mapping change is a new attribution
 * revision. A voice match is attribution evidence, never authorization for anything.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient, SqlSchema } from '@effect/sql';
import {
  type AccessScope,
  CaptureEpochId,
  Forbidden,
  type MapSpeaker,
  type MeetingId,
  NotFound,
  ProfileId,
  ProviderConnectionId,
  RevisionConflict,
  type SourceRange,
  SpeakerTrack,
  SpeakerTrackId,
  Unavailable,
  type WorkspaceId,
} from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { authorizeMeeting, requireScope } from './auth.ts';
import { engineeringDefaults } from './config.ts';
import { DbJson, DbSafeInt } from './db.ts';
import { asJobResult, currentRanges, dbFailures, MeetingJobPayload, type MeetingJob, OPEN_STATES, scheduleFinalize, selectMeeting } from './meeting-store.ts';
import { ObjectStore } from './providers/object-store.ts';
import { type DiarizedTurn, PyannoteClient, type VoiceMatch } from './providers/pyannote.ts';

/** An enrolled voice names a label only when it clearly beats every other enrolled voice; otherwise the speaker stays unknown. */
const MATCH_THRESHOLD = 70;
const MATCH_MARGIN = 15;

/** The enrolled profile a label clearly matches, or null for weak or ambiguous (similar-voice) evidence. */
const clearMatch = (match: VoiceMatch, enrolled: ReadonlyMap<string, ProfileId>) => {
  const [best, second] = Object.entries(match.scores)
    .filter(([label]) => enrolled.has(label))
    .sort((a, b) => b[1] - a[1]);
  if (best === undefined || best[1] < MATCH_THRESHOLD || best[1] - (second?.[1] ?? 0) < MATCH_MARGIN) return null;
  return { profile_id: enrolled.get(best[0])!, confidence: best[1] / 100 };
};

const TrackRow = Schema.Struct({
  id: SpeakerTrackId,
  epoch_id: CaptureEpochId,
  track: Schema.Number,
  provider: Schema.String,
  provider_label: Schema.String,
  sample_start: DbSafeInt,
  sample_end: DbSafeInt,
  profile_id: Schema.NullOr(ProfileId),
  mapping_source: Schema.NullOr(Schema.Literal('enrollment', 'user_confirmed')),
  attribution_revision: DbSafeInt,
  confidence: Schema.NullOr(Schema.Number),
});
const TRACK_COLUMNS = 'id, epoch_id, track, provider, provider_label, sample_start, sample_end, profile_id, mapping_source, attribution_revision, confidence';

/** Opens a diarization provider connection anchored at `anchor_sample`; stream rotation opens a new one, so labels never carry over. */
export const openDiarizationConnection = (input: {
  readonly workspace_id: WorkspaceId;
  readonly source: Pick<SourceRange, 'epoch_id' | 'track'>;
  readonly anchor_sample: number;
  readonly sample_rate: number;
  readonly purpose: 'diarization' | 'batch_diarization';
  readonly model: string;
  readonly closed_reason?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = ProviderConnectionId.make(randomUUID());
    const closed = input.closed_reason === undefined ? sql`NULL` : sql`UTC_TIMESTAMP(6)`;
    yield* sql`INSERT INTO provider_connections (id, workspace_id, epoch_id, track, purpose, provider, model, anchor_sample, sample_rate, opened_at, closed_at, close_reason)
      VALUES (${id}, ${input.workspace_id}, ${input.source.epoch_id}, ${input.source.track}, ${input.purpose}, 'pyannote', ${input.model}, ${input.anchor_sample},
        ${input.sample_rate}, UTC_TIMESTAMP(6), ${closed}, ${input.closed_reason ?? null})`;
    return id;
  });

const Connection = Schema.Struct({ epoch_id: CaptureEpochId, track: Schema.Number, provider: Schema.String, anchor_sample: DbSafeInt, sample_rate: DbSafeInt });
const Attribution = Schema.Struct({
  provider_label: Schema.String,
  attribution_revision: DbSafeInt,
  profile_id: Schema.NullOr(ProfileId),
  mapping_source: Schema.NullOr(Schema.Literal('enrollment', 'user_confirmed')),
});

/** Latest attribution of every label on one connection. */
const labelAttributions = (connection_id: ProviderConnectionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: Attribution,
      execute: () => sql`SELECT provider_label, MAX(attribution_revision) AS attribution_revision, NULL AS profile_id, NULL AS mapping_source
        FROM speaker_tracks WHERE provider_connection_id = ${connection_id} GROUP BY provider_label`,
    })(undefined);
    const latest = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: Attribution,
      execute: () => sql`SELECT a.provider_label, a.attribution_revision, a.profile_id, a.mapping_source FROM speaker_attributions a
        WHERE a.provider_connection_id = ${connection_id} AND a.attribution_revision = (
          SELECT MAX(b.attribution_revision) FROM speaker_attributions b WHERE b.provider_connection_id = a.provider_connection_id AND b.provider_label = a.provider_label)`,
    })(undefined);
    return new Map([...rows, ...latest].map(row => [row.provider_label, row]));
  });

/**
 * Persists provider turns (seconds from the connection's anchor) as source-sample speaker tracks.
 * New turns of an already mapped label inherit its mapping; a repeated turn is a no-op.
 */
export const recordSpeakerTurns = (input: { readonly workspace_id: WorkspaceId; readonly provider_connection_id: ProviderConnectionId; readonly turns: ReadonlyArray<DiarizedTurn> }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const connection = yield* SqlSchema.single({
      Request: Schema.Void,
      Result: Connection,
      execute: () => sql`SELECT epoch_id, track, provider, anchor_sample, sample_rate FROM provider_connections WHERE workspace_id = ${input.workspace_id} AND id = ${input.provider_connection_id}`,
    })(undefined);
    const attributions = yield* labelAttributions(input.provider_connection_id);
    const rows = input.turns
      .map(turn => {
        const known = attributions.get(turn.label);
        return {
          id: randomUUID(),
          workspace_id: input.workspace_id,
          epoch_id: connection.epoch_id,
          track: connection.track,
          provider_connection_id: input.provider_connection_id,
          provider: connection.provider,
          provider_label: turn.label,
          sample_start: connection.anchor_sample + Math.round(turn.start_s * connection.sample_rate),
          sample_end: connection.anchor_sample + Math.round(turn.end_s * connection.sample_rate),
          profile_id: known?.profile_id ?? null,
          mapping_source: known?.mapping_source ?? null,
          attribution_revision: known?.attribution_revision ?? 1,
          confidence: turn.confidence,
        };
      })
      .filter(row => row.sample_end > row.sample_start);
    if (rows.length === 0) return 0;
    const values = rows.map(row => sql`(${row.id}, ${row.workspace_id}, ${row.epoch_id}, ${row.track}, ${row.provider_connection_id}, ${row.provider}, ${row.provider_label},
      ${row.sample_start}, ${row.sample_end}, ${row.profile_id}, ${row.mapping_source}, ${row.attribution_revision}, ${row.confidence}, UTC_TIMESTAMP(6))`);
    yield* sql`INSERT INTO speaker_tracks (id, workspace_id, epoch_id, track, provider_connection_id, provider, provider_label, sample_start, sample_end, profile_id,
      mapping_source, attribution_revision, confidence, created_at) VALUES ${sql.csv(values)}
      AS fresh ON DUPLICATE KEY UPDATE sample_end = GREATEST(speaker_tracks.sample_end, fresh.sample_end)`;
    return rows.length;
  });

/** Writes the next attribution revision for every turn of one label and appends it to the history. */
const setAttribution = (input: {
  readonly workspace_id: WorkspaceId;
  readonly connection_id: string;
  readonly label: string;
  readonly revision: number;
  readonly profile_id: ProfileId | null;
  readonly source: 'enrollment' | 'user_confirmed' | null;
  readonly confidence: number | null;
  readonly actor: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE speaker_tracks SET profile_id = ${input.profile_id}, mapping_source = ${input.source}, confidence = ${input.confidence}, attribution_revision = ${input.revision}
      WHERE provider_connection_id = ${input.connection_id} AND provider_label = ${input.label}`;
    yield* sql`INSERT INTO speaker_attributions (workspace_id, provider_connection_id, provider_label, attribution_revision, profile_id, mapping_source, confidence, actor_principal_id, created_at)
      VALUES (${input.workspace_id}, ${input.connection_id}, ${input.label}, ${input.revision}, ${input.profile_id}, ${input.source}, ${input.confidence}, ${input.actor}, UTC_TIMESTAMP(6))`;
  });

/**
 * Applies voice-match scores from an identification job: a label is named only when its best
 * enrolled voice passes the threshold and clearly beats the runner-up. Similar voices stay unknown,
 * and a person's own confirmation is never overridden by a model.
 */
export const applyVoiceMatches = (workspace_id: WorkspaceId, connection_id: ProviderConnectionId, matches: ReadonlyArray<VoiceMatch>, enrolled: ReadonlyMap<string, ProfileId>) =>
  Effect.gen(function* () {
    const attributions = yield* labelAttributions(connection_id);
    let count = 0;
    for (const match of matches) {
      const current = attributions.get(match.label);
      const named = clearMatch(match, enrolled);
      if (current === undefined || current.mapping_source === 'user_confirmed' || named === null || current.profile_id === named.profile_id) continue;
      yield* setAttribution({ workspace_id, connection_id, label: match.label, revision: current.attribution_revision + 1, ...named, source: 'enrollment', actor: null });
      count++;
    }
    return count;
  });

/** Tracks overlapping any of the given sources. */
export const tracksOverlapping = (workspace_id: WorkspaceId, sources: ReadonlyArray<SourceRange>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (sources.length === 0) return [];
    const rows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: TrackRow,
      execute: () => sql`SELECT ${sql.literal(TRACK_COLUMNS)} FROM speaker_tracks WHERE workspace_id = ${workspace_id} AND (${sql.or(
        sources.map(source => sql`(epoch_id = ${source.epoch_id} AND track = ${source.track} AND sample_start < ${source.sample_end} AND sample_end > ${source.sample_start})`),
      )}) ORDER BY epoch_id, sample_start`,
    })(undefined);
    return rows.map(row => SpeakerTrack.make(row));
  });

/**
 * User correction: maps (or unmaps) every turn of the selected track's provider-local label,
 * checked against its attribution revision. Other streams' identical labels are untouched.
 */
export const mapSpeaker = (access: AccessScope, meeting_id: MeetingId, input: MapSpeaker) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* requireScope(access, 'context:write');
    yield* authorizeMeeting(access, meeting_id, 'write');
    const ranges = yield* currentRanges(access.workspace_id, meeting_id);
    const [track] = yield* sql<{ provider_connection_id: string; provider_label: string }>`SELECT t.provider_connection_id, t.provider_label FROM speaker_tracks t
      WHERE t.workspace_id = ${access.workspace_id} AND t.id = ${input.speaker_track_id}`;
    const inMeeting = (yield* tracksOverlapping(access.workspace_id, ranges)).some(candidate => candidate.id === input.speaker_track_id);
    if (track === undefined || !inMeeting) return yield* new NotFound({ message: 'Speaker track not found in this meeting' });
    if (input.profile_id !== null) {
      const [profile] = yield* sql`SELECT id FROM profiles WHERE workspace_id = ${access.workspace_id} AND id = ${input.profile_id}`;
      if (profile === undefined) return yield* new NotFound({ message: 'Profile not found' });
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [current] = yield* sql<{ revision: number }>`SELECT MAX(attribution_revision) AS revision FROM speaker_tracks
          WHERE provider_connection_id = ${track.provider_connection_id} AND provider_label = ${track.provider_label} FOR UPDATE`;
        const revision = Number(current?.revision ?? 1);
        if (revision !== input.expected_revision) return yield* new RevisionConflict({ message: `Speaker attribution is at revision ${revision}`, current_revision: revision });
        yield* setAttribution({
          workspace_id: access.workspace_id,
          connection_id: track.provider_connection_id,
          label: track.provider_label,
          revision: revision + 1,
          profile_id: input.profile_id,
          source: input.profile_id === null ? null : 'user_confirmed',
          confidence: null,
          actor: access.principal.id,
        });
        const meeting = yield* selectMeeting(access.workspace_id, meeting_id);
        if (meeting._tag === 'Some' && !OPEN_STATES.includes(meeting.value.state)) yield* scheduleFinalize(meeting.value, access.principal.id);
      }),
    );
    const rows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: TrackRow,
      execute: () => sql`SELECT ${sql.literal(TRACK_COLUMNS)} FROM speaker_tracks WHERE provider_connection_id = ${track.provider_connection_id}
        AND provider_label = ${track.provider_label} ORDER BY sample_start`,
    })(undefined);
    return rows.map(row => SpeakerTrack.make(row));
  }).pipe(dbFailures);

/** Explicit, consented enrollment: only the person a profile belongs to can enroll their own voice. */
export const enrollVoice = (access: AccessScope, input: { readonly profile_id: ProfileId; readonly voiceprint: string; readonly consent_version: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [profile] = yield* sql<{ principal_id: string | null }>`SELECT principal_id FROM profiles WHERE workspace_id = ${access.workspace_id} AND id = ${input.profile_id}`;
    if (access.principal.kind !== 'human' || profile === undefined || profile.principal_id !== access.principal.id) {
      return yield* new Forbidden({ message: 'Only the person a profile belongs to can enroll their voice' });
    }
    const id = randomUUID();
    yield* sql`INSERT INTO voice_enrollments (id, workspace_id, principal_id, profile_id, provider, voiceprint, consent_version, consented_at, created_at)
      VALUES (${id}, ${access.workspace_id}, ${access.principal.id}, ${input.profile_id}, 'pyannote', ${input.voiceprint}, ${input.consent_version}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    return id;
  }).pipe(dbFailures);

export const revokeEnrollment = (access: AccessScope, enrollment_id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql`SELECT id FROM voice_enrollments WHERE workspace_id = ${access.workspace_id} AND id = ${enrollment_id} AND principal_id = ${access.principal.id} AND revoked_at IS NULL`;
    if (row === undefined) return yield* new NotFound({ message: 'Enrollment not found' });
    yield* sql`UPDATE voice_enrollments SET revoked_at = UTC_TIMESTAMP(6) WHERE id = ${enrollment_id}`;
  }).pipe(dbFailures);

/** Maps a turn in the assembled cut (seconds from its start) back to source ranges through the cut's pieces. */
const turnSources = (pieces: ReadonlyArray<SourceRange>, rate: number, turn: DiarizedTurn) => {
  const from = Math.round(turn.start_s * rate);
  const to = Math.round(turn.end_s * rate);
  const sources: Array<SourceRange> = [];
  let offset = 0;
  for (const piece of pieces) {
    const length = piece.sample_end - piece.sample_start;
    const start = Math.max(from, offset);
    const end = Math.min(to, offset + length);
    if (end > start) sources.push({ ...piece, sample_start: piece.sample_start + start - offset, sample_end: piece.sample_start + end - offset });
    offset += length;
  }
  return sources;
};

const RecordingRow = Schema.Struct({ object_key: Schema.String, sample_rate: DbSafeInt, pieces: DbJson(Schema.Array(Schema.Struct({ epoch_id: CaptureEpochId, track: Schema.Number, sample_start: Schema.Number, sample_end: Schema.Number }))) });

/**
 * `speakers.refine`: batch diarization (and identification against active enrollments) over the
 * current revision's cut. Skipped with a reason when pyannote is not configured.
 */
export const refineSpeakers = (job: MeetingJob) =>
  asJobResult(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const pyannote = yield* PyannoteClient;
      if (!pyannote.configured) return { skipped: 'pyannote diarization is not configured' };
      const { meeting_id } = yield* Schema.decodeUnknown(MeetingJobPayload)(job.payload);
      const meeting = yield* selectMeeting(job.workspace_id, meeting_id);
      if (meeting._tag === 'None' || OPEN_STATES.includes(meeting.value.state)) return { skipped: 'meeting is open or missing' };
      const revision = meeting.value.boundary_revision;
      const tag = `meeting:${meeting_id}:r${revision}`;
      const [done] = yield* sql`SELECT id FROM provider_connections WHERE workspace_id = ${job.workspace_id} AND purpose = 'batch_diarization' AND close_reason = ${tag} LIMIT 1`;
      if (done !== undefined) return { skipped: 'already refined for this boundary revision' };
      const recording = yield* SqlSchema.single({
        Request: Schema.Void,
        Result: RecordingRow,
        execute: () => sql`SELECT object_key, sample_rate, pieces FROM meeting_recordings WHERE meeting_id = ${meeting_id} AND boundary_revision = ${revision}`,
      })(undefined).pipe(Effect.mapError(() => new Unavailable({ message: `recording for revision ${revision} is not assembled`, retryable: true })));
      const url = yield* Effect.flatMap(ObjectStore, store => store.presignGet(recording.object_key, engineeringDefaults.playbackUrlTtlMs));
      const enrollments = yield* sql<{ profile_id: ProfileId; voiceprint: string }>`SELECT profile_id, voiceprint FROM voice_enrollments WHERE workspace_id = ${job.workspace_id} AND revoked_at IS NULL`;
      const result = yield* pyannote.diarize({ url, voiceprints: enrollments.map(row => ({ label: row.profile_id, voiceprint: row.voiceprint })) });
      const enrolled = new Map(enrollments.map(row => [row.profile_id, row.profile_id]));
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const connections = new Map<string, ProviderConnectionId>();
          let turns = 0;
          let named = 0;
          for (const piece of recording.pieces) {
            const key = `${piece.epoch_id}/${piece.track}`;
            if (connections.has(key)) continue;
            const connection = yield* openDiarizationConnection({ workspace_id: job.workspace_id, source: piece, anchor_sample: 0, sample_rate: recording.sample_rate, purpose: 'batch_diarization', model: result.model, closed_reason: tag });
            connections.set(key, connection);
            const mine = result.turns.flatMap(turn =>
              turnSources(recording.pieces, recording.sample_rate, turn)
                .filter(source => source.epoch_id === piece.epoch_id && source.track === piece.track)
                .map(source => ({ ...turn, start_s: source.sample_start / recording.sample_rate, end_s: source.sample_end / recording.sample_rate })),
            );
            turns += yield* recordSpeakerTurns({ workspace_id: job.workspace_id, provider_connection_id: connection, turns: mine });
            named += yield* applyVoiceMatches(job.workspace_id, connection, result.matches, enrolled);
          }
          return { boundary_revision: revision, turns, named };
        }),
      );
    }),
  );
