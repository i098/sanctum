/**
 * Per-meeting recording cuts and signed playback (plan section 06, T13). A cut is assembled from
 * committed R2 chunks inside the meeting's current ranges only, stored per boundary revision, and
 * every URL is issued after a fresh access check for the current revision's cut.
 */
import { createHash, randomUUID } from 'node:crypto';
import { SqlClient, SqlSchema } from '@effect/sql';
import { type AccessScope, type MeetingId, type RecordingAccess, SourceRange, Unavailable, UtcTimestamp } from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { authorizeMeeting, requireScope } from './auth.ts';
import { engineeringDefaults } from './config.ts';
import { DbJson, DbSafeInt, DbSha256 } from './db.ts';
import { enqueueJob } from './jobs.ts';
import { asJobResult, currentRanges, MeetingJobPayload, type MeetingJob, OPEN_STATES, selectMeeting, type TimedRange } from './meeting-store.ts';
import { ObjectStore } from './object-store.ts';

const ChunkRow = Schema.Struct({ sample_start: DbSafeInt, sample_count: DbSafeInt, sha256: DbSha256, object_key: Schema.String });

const RecordingRow = Schema.Struct({ object_key: Schema.String, pieces: DbJson(Schema.Array(SourceRange)) });

/** Mono PCM16 WAV file holding `parts` at `rate`. */
const wavFile = (rate: number, parts: ReadonlyArray<Uint8Array>) => {
  const bytes = parts.reduce((total, part) => total + part.byteLength, 0);
  const header = Buffer.alloc(44);
  header.write('RIFFxxxxWAVEfmt ', 0, 'ascii');
  header.writeUInt32LE(36 + bytes, 4);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(bytes, 40);
  // A plain copy: Buffer.slice/subarray share memory, which callers of the object store do not expect.
  return new Uint8Array(Buffer.concat([header, ...parts]));
};

/** Parts of `ranges` not covered by `pieces`: audio the meeting owns but no saved chunk supplied. */
const gapsOf = (ranges: ReadonlyArray<SourceRange>, pieces: ReadonlyArray<SourceRange>): Array<SourceRange> =>
  ranges.flatMap(range => {
    const gaps: Array<SourceRange> = [];
    let cursor = range.sample_start;
    const inside = pieces
      .filter(piece => piece.epoch_id === range.epoch_id && piece.track === range.track && piece.sample_end > range.sample_start && piece.sample_start < range.sample_end)
      .sort((a, b) => a.sample_start - b.sample_start);
    for (const piece of inside) {
      if (piece.sample_start > cursor) gaps.push({ ...range, sample_start: cursor, sample_end: piece.sample_start });
      cursor = Math.max(cursor, piece.sample_end);
    }
    if (cursor < range.sample_end) gaps.push({ ...range, sample_start: cursor, sample_end: range.sample_end });
    return gaps;
  });

/** Verified PCM of one range from its committed chunks; a missing or corrupt chunk leaves a gap instead of invented audio. */
const cutRange = (workspace_id: string, range: TimedRange) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ObjectStore;
    const chunks = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: ChunkRow,
      execute: () => sql`SELECT sample_start, sample_count, sha256, object_key FROM recording_chunks
        WHERE workspace_id = ${workspace_id} AND epoch_id = ${range.epoch_id} AND track = ${range.track} AND upload_state = 'committed'
          AND sample_start < ${range.sample_end} AND sample_start + sample_count > ${range.sample_start} ORDER BY sample_start`,
    })(undefined);
    const pieces: Array<SourceRange> = [];
    const parts: Array<Uint8Array> = [];
    for (const chunk of chunks) {
      const body = yield* store.get(chunk.object_key);
      if (createHash('sha256').update(body).digest('hex') !== chunk.sha256) continue;
      const from = Math.max(range.sample_start, chunk.sample_start);
      const to = Math.min(range.sample_end, chunk.sample_start + chunk.sample_count);
      parts.push(body.subarray(44 + (from - chunk.sample_start) * 2, 44 + (to - chunk.sample_start) * 2));
      const last = pieces.at(-1);
      if (last !== undefined && last.sample_end === from) pieces[pieces.length - 1] = { ...last, sample_end: to };
      else pieces.push({ epoch_id: range.epoch_id, track: range.track, sample_start: from, sample_end: to });
    }
    return { pieces, parts };
  });

/**
 * `recording.assemble`: writes `meetings/<workspace>/<meeting>/r<revision>.wav` for a sealed
 * meeting's current boundary revision, then queues speaker refinement over that cut.
 */
export const assembleRecording = (job: MeetingJob) =>
  asJobResult(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ObjectStore;
      const { meeting_id } = yield* Schema.decodeUnknown(MeetingJobPayload)(job.payload);
      const found = yield* selectMeeting(job.workspace_id, meeting_id);
      if (found._tag === 'None' || OPEN_STATES.includes(found.value.state)) return { skipped: 'meeting is open or missing' };
      const revision = found.value.boundary_revision;
      const [existing] = yield* sql<{ object_key: string }>`SELECT object_key FROM meeting_recordings WHERE meeting_id = ${meeting_id} AND boundary_revision = ${revision}`;
      if (existing !== undefined) return { object_key: existing.object_key, boundary_revision: revision };
      const ranges = yield* currentRanges(job.workspace_id, meeting_id);
      const rate = ranges[0]?.epoch.sample_rate ?? 0;
      const pieces: Array<SourceRange> = [];
      const parts: Array<Uint8Array> = [];
      // ponytail: whole cut in worker memory and ranges at another sample rate become gaps; stream a multipart upload and add verified resampling when meetings outgrow this.
      for (const range of ranges.filter(candidate => candidate.epoch.sample_rate === rate)) {
        const cut = yield* cutRange(job.workspace_id, range);
        pieces.push(...cut.pieces);
        parts.push(...cut.parts);
      }
      const status = parts.length === 0 ? 'failed' : gapsOf(ranges, pieces).length === 0 ? 'complete' : 'partial';
      const setStatus = sql`UPDATE meetings SET processing = JSON_SET(processing, '$.recording', ${status}), updated_at = UTC_TIMESTAMP(6)
        WHERE id = ${meeting_id} AND boundary_revision = ${revision}`;
      if (parts.length === 0) return yield* Effect.as(setStatus, { missing: 'no committed audio inside the meeting ranges', boundary_revision: revision });
      const wav = wavFile(rate, parts);
      const sha256 = createHash('sha256').update(wav).digest('hex');
      const object_key = `meetings/${job.workspace_id}/${meeting_id}/r${revision}.wav`;
      yield* store.put(object_key, wav, { sha256, contentType: 'audio/wav' });
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO meeting_recordings (id, workspace_id, meeting_id, boundary_revision, object_key, sha256, byte_length, sample_rate, sample_count, pieces, created_at)
            VALUES (${randomUUID()}, ${job.workspace_id}, ${meeting_id}, ${revision}, ${object_key}, ${Buffer.from(sha256, 'hex')}, ${wav.byteLength}, ${rate},
              ${(wav.byteLength - 44) / 2}, ${JSON.stringify(pieces)}, UTC_TIMESTAMP(6))
            ON DUPLICATE KEY UPDATE id = id`;
          yield* setStatus;
          yield* enqueueJob({ workspace_id: job.workspace_id, kind: 'speakers.refine', work_key: `meeting:${meeting_id}`, payload: { meeting_id }, requested_by: job.requested_by, source_revision: revision });
        }),
      );
      return { object_key, boundary_revision: revision, status };
    }),
  );

/** Short-lived signed URL for the current boundary revision's cut, after a fresh scope and meeting access check. */
export const issueRecordingAccess = (access: AccessScope, meeting_id: MeetingId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* requireScope(access, 'recordings:read');
    yield* authorizeMeeting(access, meeting_id, 'read');
    const found = yield* selectMeeting(access.workspace_id, meeting_id);
    if (found._tag === 'None') return yield* Effect.die(new Error(`meeting ${meeting_id} vanished after authorization`));
    const meeting = found.value;
    const recording = yield* SqlSchema.findOne({
      Request: Schema.Void,
      Result: RecordingRow,
      execute: () => sql`SELECT object_key, pieces FROM meeting_recordings WHERE meeting_id = ${meeting_id} AND boundary_revision = ${meeting.boundary_revision}`,
    })(undefined);
    if (recording._tag === 'None') {
      const failed = meeting.processing.recording === 'failed';
      const message = OPEN_STATES.includes(meeting.state)
        ? 'The recording is assembled after the meeting closes'
        : failed ? 'No saved audio exists for this meeting' : `The recording for boundary revision ${meeting.boundary_revision} is not assembled yet`;
      return yield* new Unavailable({ message, retryable: !failed });
    }
    const ttl = engineeringDefaults.playbackUrlTtlMs;
    const url = yield* Effect.flatMap(ObjectStore, store => store.presignGet(recording.value.object_key, ttl));
    const ranges = yield* currentRanges(access.workspace_id, meeting_id);
    return {
      meeting_id,
      boundary_revision: meeting.boundary_revision,
      url,
      expires_at: UtcTimestamp.make(new Date(Date.now() + ttl).toISOString()),
      gaps: gapsOf(ranges, recording.value.pieces),
    } satisfies RecordingAccess;
  }).pipe(
    Effect.catchTags({
      SqlError: () => new Unavailable({ message: 'Database unavailable', retryable: true }),
      ObjectStoreError: () => new Unavailable({ message: 'Recording storage unavailable', retryable: true }),
      ParseError: error => Effect.die(error),
    }),
  );
