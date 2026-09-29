/** Listener registration, capture epochs, source clocks and recording chunk manifests (plan section 05). */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import {
  CaptureEpochId,
  IanaTimeZone,
  ListenerId,
  RecordingChunkId,
  SampleIndex,
  SampleRate,
  Sha256Hex,
  UtcTimestamp,
  WorkspaceId,
} from './common.ts';

export const ListenerMode = Schema.Literal('room', 'laptop');
export const ListenerState = Schema.Literal('stopped', 'starting', 'listening', 'reconnecting', 'paused', 'degraded');
export type ListenerState = typeof ListenerState.Type;

/** Ownership generation; increments on every handoff so stale owners are rejected. */
export const LeaseGeneration = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

export const Listener = Schema.Struct({
  id: ListenerId,
  workspace_id: WorkspaceId,
  name: Schema.String,
  mode: ListenerMode,
  state: ListenerState,
  lease_generation: LeaseGeneration,
  lease_expires_at: Schema.NullOr(UtcTimestamp),
  current_epoch_id: Schema.NullOr(CaptureEpochId),
  last_heartbeat_at: Schema.NullOr(UtcTimestamp),
});
export type Listener = typeof Listener.Type;

/**
 * Anchor of one continuous sample clock: sample `sample_start` was captured at `captured_at`
 * (browser wall clock, UTC) in `timezone`. Elapsed time is derived from sample counts.
 */
export const SourceClock = Schema.Struct({
  sample_rate: SampleRate,
  channels: Schema.Literal(1),
  encoding: Schema.Literal('pcm_s16le'),
  sample_start: SampleIndex,
  captured_at: UtcTimestamp,
  timezone: IanaTimeZone,
});
export type SourceClock = typeof SourceClock.Type;

export const EpochStartReason = Schema.Literal('start', 'resume', 'reload', 'device_change', 'stream_restart');
export const EpochEndReason = Schema.Literal('pause', 'close', 'interrupted', 'device_change', 'lease_lost');

export const CaptureEpoch = Schema.Struct({
  id: CaptureEpochId,
  listener_id: ListenerId,
  lease_generation: LeaseGeneration,
  clock: SourceClock,
  start_reason: EpochStartReason,
  started_at: UtcTimestamp,
  ended_at: Schema.NullOr(UtcTimestamp),
  end_reason: Schema.NullOr(EpochEndReason),
});
export type CaptureEpoch = typeof CaptureEpoch.Type;

/** Plan default: independent 30-second PCM16 WAV chunks; the upper bound leaves room for 96 kHz. */
export const MAX_CHUNK_BYTES = 96_000 * 2 * 30 + 44;

/** Manifest sent with one independent WAV archive chunk (`PUT /api/v1/listeners/{id}/chunks/{chunk_id}`). */
export const RecordingChunkManifest = Schema.Struct({
  chunk_id: RecordingChunkId,
  listener_id: ListenerId,
  epoch_id: CaptureEpochId,
  track: Schema.Number.pipe(Schema.int(), Schema.between(0, 65_535)),
  sequence: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  sample_start: SampleIndex,
  sample_count: Schema.Number.pipe(Schema.int(), Schema.positive()),
  sample_rate: SampleRate,
  captured_at: UtcTimestamp,
  byte_length: Schema.Number.pipe(Schema.int(), Schema.between(45, MAX_CHUNK_BYTES)),
  sha256: Sha256Hex,
});
export type RecordingChunkManifest = typeof RecordingChunkManifest.Type;

/** Remote durability proof: returned only after the R2 object and the database manifest both exist. */
export const RecordingChunkReceipt = Schema.Struct({
  chunk_id: RecordingChunkId,
  object_key: Schema.String,
  sha256: Sha256Hex,
  byte_length: Schema.Number.pipe(Schema.int(), Schema.positive()),
  committed_at: UtcTimestamp,
});
export type RecordingChunkReceipt = typeof RecordingChunkReceipt.Type;

export const RegisterListener = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  mode: ListenerMode,
  /** Browser capability report (AudioWorklet, Wake Lock, storage persistence, sample rates). */
  capabilities: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

export const Heartbeat = Schema.Struct({
  lease_generation: LeaseGeneration,
  state: ListenerState,
  epoch_id: Schema.NullOr(CaptureEpochId),
  buffered_chunks: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  storage_bytes_free: Schema.NullOr(Schema.Number.pipe(Schema.nonNegative())),
});

/** `owner: false` means another listener holds the capture-group lease; stop live writes. */
export const HeartbeatReceipt = Schema.Struct({
  lease_generation: LeaseGeneration,
  lease_expires_at: UtcTimestamp,
  owner: Schema.Boolean,
});

const listenerId = HttpApiSchema.param('listener_id', ListenerId);
const chunkId = HttpApiSchema.param('chunk_id', RecordingChunkId);

/**
 * Listener device API (plan section 12). The live stream is a WebSocket upgrade on
 * `LISTENER_STREAM_PATH` speaking the protocol in media.ts. Owned by the media slice, which
 * registers it in api.ts behind `Authenticated`; the capture slice is its browser client.
 */
export class ListenersApi extends HttpApiGroup.make('listeners')
  .add(HttpApiEndpoint.post('registerListener', '/listeners').setPayload(RegisterListener).addSuccess(Listener, { status: 201 }))
  .add(HttpApiEndpoint.post('heartbeat')`/listeners/${listenerId}/heartbeat`.setPayload(Heartbeat).addSuccess(HeartbeatReceipt))
  .add(
    HttpApiEndpoint.put('putChunk')`/listeners/${listenerId}/chunks/${chunkId}`
      .setHeaders(Schema.Struct({ 'x-sanctum-manifest': Schema.parseJson(RecordingChunkManifest) }))
      .setPayload(HttpApiSchema.Uint8Array({ contentType: 'audio/wav' }))
      .addSuccess(RecordingChunkReceipt),
  )
  .prefix('/api/v1') {}

/** WebSocket upgrade path for live PCM; `:listener_id` is the registered listener. */
export const LISTENER_STREAM_PATH = '/api/v1/listeners/:listener_id/stream';
