/**
 * Recording chunk ingest (plan section 05 "Browser recovery buffer", T09). A receipt is returned only
 * once the R2 object and the committed manifest row both exist. Retries are idempotent: the same chunk
 * and hash return the original receipt, different content is a conflict, and an object that landed
 * before a failed commit is reconciled with `head` instead of being written again.
 */
import { createHash } from 'node:crypto';
import { HttpApiError } from '@effect/platform';
import { SqlClient, SqlSchema } from '@effect/sql';
import {
  type AccessScope,
  CaptureEpochId,
  Forbidden,
  HashConflict,
  ListenerId,
  NotFound,
  RecordingChunkId,
  type RecordingChunkManifest,
  SampleRate,
  type RecordingChunkReceipt,
  type SourceRange,
  Unavailable,
  type WorkspaceId,
} from '@sanctum/contracts';
import { Effect, Option, Schema } from 'effect';
import { DbSafeInt, DbSha256, DbUtc } from './db.ts';
import { enqueueJob } from './jobs.ts';
import { ObjectStore, type ObjectStoreError } from './providers/object-store.ts';

/** Batch reconciliation waits this long after an upload so live finals for the range can land first. */
const RECONCILE_DELAY_MS = 60_000;

const invalid = (message: string) => new HttpApiError.HttpApiDecodeError({ message: `Invalid chunk: ${message}`, issues: [] });

/** Why `body` is not the canonical 44-byte-header mono PCM16 WAV the manifest describes, or null. */
function wavError(body: Uint8Array, manifest: RecordingChunkManifest): string | null {
  const dataBytes = manifest.sample_count * 2;
  if (body.byteLength !== manifest.byte_length || manifest.byte_length !== 44 + dataBytes) return 'byte_length must equal the body and 44 + 2 * sample_count';
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const tags = [0, 8, 12, 36].map(offset => String.fromCharCode(...body.subarray(offset, offset + 4))).join('');
  if (tags !== 'RIFFWAVEfmt data') return 'not a canonical RIFF/WAVE file';
  // RIFF size, fmt size, PCM format, mono, sample rate, 16-bit samples, data size.
  const fields = [view.getUint32(4, true), view.getUint32(16, true), view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true), view.getUint32(40, true)];
  const expected = [body.byteLength - 8, 16, 1, 1, manifest.sample_rate, 16, dataBytes];
  return fields.every((value, i) => value === expected[i]) ? null : 'expected mono PCM16 at the manifest sample rate and count';
}

const ChunkRow = Schema.Struct({
  id: RecordingChunkId,
  listener_id: ListenerId,
  epoch_id: CaptureEpochId,
  track: DbSafeInt,
  sequence: DbSafeInt,
  sample_start: DbSafeInt,
  sample_count: DbSafeInt,
  sample_rate: DbSafeInt.pipe(Schema.compose(SampleRate)),
  captured_at: DbUtc,
  byte_length: DbSafeInt,
  sha256: DbSha256,
  object_key: Schema.String,
  committed_at: Schema.NullOr(DbUtc),
});
type ChunkRow = typeof ChunkRow.Type;

const CHUNK_COLUMNS = 'id, listener_id, epoch_id, track, sequence, sample_start, sample_count, sample_rate, captured_at, byte_length, sha256, object_key, committed_at';

const chunksWhere = (condition: (sql: SqlClient.SqlClient) => ReturnType<SqlClient.SqlClient['and']>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ChunkRow,
      execute: () => sql`SELECT ${sql.unsafe(CHUNK_COLUMNS)} FROM recording_chunks WHERE ${condition(sql)} ORDER BY sample_start`,
    });
    return yield* find(undefined).pipe(Effect.catchTag('ParseError', Effect.die));
  });

/** Committed chunks overlapping `source`, in source order, with their private object keys. */
export const listCommittedChunks = (input: { readonly workspace_id: WorkspaceId; readonly source: SourceRange }) =>
  chunksWhere(sql =>
    sql.and([
      sql`workspace_id = ${input.workspace_id} AND epoch_id = ${input.source.epoch_id} AND track = ${input.source.track} AND upload_state = 'committed'`,
      sql`sample_start < ${input.source.sample_end} AND sample_start + sample_count > ${input.source.sample_start}`,
    ]),
  ).pipe(
    Effect.map(rows =>
      rows.map(({ id, committed_at: _committed, ...row }): RecordingChunkManifest & { object_key: string } => ({ chunk_id: id, ...row })),
    ),
  );

const receipt = (row: ChunkRow): RecordingChunkReceipt => ({
  chunk_id: row.id,
  object_key: row.object_key,
  sha256: row.sha256,
  byte_length: row.byte_length,
  committed_at: row.committed_at!,
});

const storageUnavailable = (error: ObjectStoreError) => new Unavailable({ message: `Recording storage failed: ${error.message}`, retryable: true });

/** Writes the object unless an identical one already landed; an ambiguous write is resolved by `head`. */
const storeObject = (key: string, body: Uint8Array, sha256: string) =>
  Effect.gen(function* () {
    const store = yield* ObjectStore;
    const landed = (object: { sha256: string } | null) => object !== null && object.sha256 === sha256;
    if (landed(yield* store.head(key))) return;
    yield* store.put(key, body, { sha256, contentType: 'audio/wav' }).pipe(
      Effect.catchIf(
        error => error.ambiguous,
        error => Effect.flatMap(store.head(key), object => (landed(object) ? Effect.void : Effect.fail(error))),
      ),
    );
  }).pipe(Effect.mapError(storageUnavailable));

const EpochClock = Schema.Struct({ sample_rate: DbSafeInt, sample_start: DbSafeInt });

/** The epoch's clock when it belongs to `listener_id` and that listener to the caller. */
const ownedEpoch = (access: AccessScope, listener_id: ListenerId, epoch_id: CaptureEpochId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findOne({
      Request: CaptureEpochId,
      Result: EpochClock,
      execute: id => sql`
        SELECT e.sample_rate, e.sample_start FROM capture_epochs e
        JOIN listeners l ON l.workspace_id = e.workspace_id AND l.id = e.listener_id
        WHERE e.workspace_id = ${access.workspace_id} AND e.id = ${id} AND l.id = ${listener_id} AND l.principal_id = ${access.principal.id}`,
    });
    return yield* find(epoch_id).pipe(Effect.catchTag('ParseError', Effect.die));
  });

/** Checks ownership, epoch clock, WAV shape and hash; returns the body's SHA-256. */
const validateChunk = (access: AccessScope, listener_id: ListenerId, chunk_id: RecordingChunkId, manifest: RecordingChunkManifest, body: Uint8Array) =>
  Effect.gen(function* () {
    if (manifest.chunk_id !== chunk_id || manifest.listener_id !== listener_id) return yield* invalid('manifest does not match the request path');
    if (!access.scopes.includes('capture:ingest')) {
      return yield* new Forbidden({ message: 'The capture:ingest scope is required', required_scope: 'capture:ingest' });
    }
    const epoch = yield* ownedEpoch(access, listener_id, manifest.epoch_id);
    if (Option.isNone(epoch)) return yield* new NotFound({ message: 'Capture epoch not found for this listener' });
    if (epoch.value.sample_rate !== manifest.sample_rate || manifest.sample_start < epoch.value.sample_start) {
      return yield* invalid('sample rate or range does not match the epoch clock');
    }
    const shapeError = wavError(body, manifest);
    if (shapeError !== null) return yield* invalid(shapeError);
    const sha256 = createHash('sha256').update(body).digest('hex');
    return sha256 === manifest.sha256 ? sha256 : yield* invalid('sha256 does not match the body');
  });

/** Inserts the pending manifest row once; another chunk on the same sequence/range, or this ID with other content, conflicts. */
const claimManifest = (access: AccessScope, manifest: RecordingChunkManifest, sha256: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { chunk_id, epoch_id, track, sample_start } = manifest;
    const [overlap] = yield* chunksWhere(sql =>
      sql.and([
        sql`workspace_id = ${access.workspace_id} AND epoch_id = ${epoch_id} AND track = ${track} AND id <> ${chunk_id}`,
        sql`(sequence = ${manifest.sequence} OR (sample_start < ${sample_start + manifest.sample_count} AND sample_start + sample_count > ${sample_start}))`,
      ]),
    );
    if (overlap !== undefined) return yield* new HashConflict({ message: 'Another chunk already holds this sequence or source range', existing_sha256: overlap.sha256 });
    const object_key = `workspaces/${access.workspace_id}/epochs/${epoch_id}/tracks/${track}/${sample_start}-${chunk_id}.wav`;
    yield* sql`
      INSERT IGNORE INTO recording_chunks (id, workspace_id, listener_id, epoch_id, track, sequence, sample_start, sample_count, sample_rate, captured_at,
                                           byte_length, sha256, object_key, upload_state, created_at)
      VALUES (${chunk_id}, ${access.workspace_id}, ${manifest.listener_id}, ${epoch_id}, ${track}, ${manifest.sequence}, ${sample_start},
              ${manifest.sample_count}, ${manifest.sample_rate}, ${Schema.encodeSync(DbUtc)(manifest.captured_at)}, ${manifest.byte_length},
              ${Buffer.from(sha256, 'hex')}, ${object_key}, 'pending', UTC_TIMESTAMP(6))`;
    const [row] = yield* chunksWhere(sql => sql`workspace_id = ${access.workspace_id} AND id = ${chunk_id}`);
    if (row === undefined || row.sha256 !== sha256) {
      return yield* new HashConflict({ message: 'This chunk ID was already uploaded with different content', existing_sha256: row?.sha256 ?? '' });
    }
    return row;
  });

/** Validates, stores and commits one archive chunk, then schedules transcript reconciliation for its range. */
export const putChunk = (access: AccessScope, listener_id: ListenerId, chunk_id: RecordingChunkId, manifest: RecordingChunkManifest, body: Uint8Array) =>
  Effect.gen(function* () {
    const sha256 = yield* validateChunk(access, listener_id, chunk_id, manifest, body);
    const row = yield* claimManifest(access, manifest, sha256);
    if (row.committed_at !== null) return receipt(row);
    yield* storeObject(row.object_key, body, sha256);
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          UPDATE recording_chunks SET upload_state = 'committed', committed_at = UTC_TIMESTAMP(6)
          WHERE workspace_id = ${access.workspace_id} AND id = ${chunk_id} AND upload_state = 'pending'`;
        yield* enqueueJob({
          workspace_id: access.workspace_id,
          kind: 'transcript.reconcile',
          work_key: `${manifest.epoch_id}:${manifest.track}:${manifest.sample_start}`,
          payload: { epoch_id: manifest.epoch_id, track: manifest.track, sample_start: manifest.sample_start, sample_end: manifest.sample_start + manifest.sample_count },
          requested_by: access.principal.id,
          delay_ms: RECONCILE_DELAY_MS,
        });
      }),
    );
    const [committed] = yield* chunksWhere(sql => sql`workspace_id = ${access.workspace_id} AND id = ${chunk_id}`);
    return receipt(committed!);
  });
