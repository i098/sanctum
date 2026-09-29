/**
 * Live media wire protocol (plan section 05, "Live path").
 *
 * Text WebSocket frames carry JSON control messages (below). Binary frames carry audio:
 *
 * | Offset | Type   | Field         | Rule                                             |
 * | ------ | ------ | ------------- | ------------------------------------------------ |
 * | 0      | u8     | version       | `MEDIA_PROTOCOL_VERSION`                         |
 * | 1      | u8     | kind          | `1` = PCM16 little-endian audio                  |
 * | 2      | u16 LE | track         | source track within the epoch                    |
 * | 4      | u32 LE | sequence      | per-epoch frame counter                          |
 * | 8      | u64 LE | sample_start  | epoch sample index; must be <= 2^53 - 1          |
 * | 16     | u32 LE | sample_count  | 1..`MAX_FRAME_SAMPLES`                           |
 * | 20     | u32 LE | reserved      | must be 0                                        |
 * | 24     | i16 LE | samples       | exactly `sample_count` mono samples              |
 *
 * Structural validation lives here; sequence/range continuity, rate and authorization are
 * checked by the server session against the accepted `start` message.
 */
import { Schema } from 'effect';
import { SourceClock, LeaseGeneration } from './capture.ts';
import { CaptureEpochId, ListenerId, SampleIndex } from './common.ts';
import { TranscriptSegment } from './transcripts.ts';

export const MEDIA_PROTOCOL_VERSION = 1;
export const FRAME_KIND_PCM16 = 1;
export const FRAME_HEADER_BYTES = 24;
/** 100 ms at 96 kHz, the top of the 20-100 ms live frame range at the highest accepted rate. */
export const MAX_FRAME_SAMPLES = 9_600;
export const MAX_FRAME_BYTES = FRAME_HEADER_BYTES + MAX_FRAME_SAMPLES * 2;

export interface PcmFrameHeader {
  readonly track: number;
  readonly sequence: number;
  readonly sample_start: number;
  readonly sample_count: number;
}

export interface PcmFrame extends PcmFrameHeader {
  /** View into the received bytes when aligned; a copy otherwise. Do not retain past the handler. */
  readonly samples: Int16Array;
}

export type FrameError =
  | 'too_short'
  | 'too_long'
  | 'unsupported_version'
  | 'unsupported_kind'
  | 'reserved_not_zero'
  | 'empty_frame'
  | 'unsafe_sample_start'
  | 'length_mismatch';

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const fits = (value: number, max: number) => Number.isInteger(value) && value >= 0 && value <= max;

function headerRangeError(header: PcmFrameHeader, samples: Int16Array): string | null {
  const count = samples.length;
  if (count === 0 || count !== header.sample_count || !fits(count, MAX_FRAME_SAMPLES)) return 'sample_count must equal samples.length within MAX_FRAME_SAMPLES';
  if (!fits(header.track, 0xffff)) return 'track must fit u16';
  if (!fits(header.sequence, 0xffff_ffff)) return 'sequence must fit u32';
  return fits(header.sample_start, Number.MAX_SAFE_INTEGER) ? null : 'unsafe sample_start';
}

export function encodePcmFrame(header: PcmFrameHeader, samples: Int16Array): Uint8Array {
  const problem = headerRangeError(header, samples);
  if (problem !== null) throw new RangeError(problem);
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + samples.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, MEDIA_PROTOCOL_VERSION);
  view.setUint8(1, FRAME_KIND_PCM16);
  view.setUint16(2, header.track, true);
  view.setUint32(4, header.sequence, true);
  view.setBigUint64(8, BigInt(header.sample_start), true);
  view.setUint32(16, header.sample_count, true);
  if (LITTLE_ENDIAN_HOST) bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), FRAME_HEADER_BYTES);
  else for (let i = 0; i < samples.length; i++) view.setInt16(FRAME_HEADER_BYTES + i * 2, samples[i]!, true);
  return bytes;
}

function headerError(view: DataView, byteLength: number): FrameError | null {
  if (byteLength < FRAME_HEADER_BYTES) return 'too_short';
  if (byteLength > MAX_FRAME_BYTES) return 'too_long';
  if (view.getUint8(0) !== MEDIA_PROTOCOL_VERSION) return 'unsupported_version';
  if (view.getUint8(1) !== FRAME_KIND_PCM16) return 'unsupported_kind';
  if (view.getUint32(20, true) !== 0) return 'reserved_not_zero';
  const count = view.getUint32(16, true);
  if (count === 0) return 'empty_frame';
  if (view.getBigUint64(8, true) > BigInt(Number.MAX_SAFE_INTEGER)) return 'unsafe_sample_start';
  return byteLength === FRAME_HEADER_BYTES + count * 2 ? null : 'length_mismatch';
}

function readSamples(bytes: Uint8Array, count: number): Int16Array {
  const offset = bytes.byteOffset + FRAME_HEADER_BYTES;
  if (LITTLE_ENDIAN_HOST && offset % 2 === 0) return new Int16Array(bytes.buffer, offset, count);
  const view = new DataView(bytes.buffer, offset, count * 2);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true);
  return samples;
}

/** Validates one untrusted binary frame without copying aligned payloads. */
export function decodePcmFrame(bytes: Uint8Array): { readonly frame: PcmFrame } | { readonly error: FrameError } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const error = headerError(view, bytes.byteLength);
  if (error !== null) return { error };
  const sample_count = view.getUint32(16, true);
  return {
    frame: {
      track: view.getUint16(2, true),
      sequence: view.getUint32(4, true),
      sample_start: Number(view.getBigUint64(8, true)),
      sample_count,
      samples: readSamples(bytes, sample_count),
    },
  };
}

/** Client -> server: first text message after the authenticated upgrade; audio waits for `accepted`. */
export const StartMessage = Schema.TaggedStruct('start', {
  protocol_version: Schema.Literal(MEDIA_PROTOCOL_VERSION),
  listener_id: ListenerId,
  epoch_id: CaptureEpochId,
  track: Schema.Number.pipe(Schema.int(), Schema.between(0, 65_535)),
  clock: SourceClock,
  lease_generation: LeaseGeneration,
});

export const StopMessage = Schema.TaggedStruct('stop', {
  reason: Schema.Literal('pause', 'close', 'device_change'),
});

export const ClientControlMessage = Schema.Union(StartMessage, StopMessage);
export type ClientControlMessage = typeof ClientControlMessage.Type;

/** Server -> client. `resume_from_sample` is the live watermark, so reconnect continues instead of restarting. */
export const AcceptedMessage = Schema.TaggedStruct('accepted', {
  epoch_id: CaptureEpochId,
  resume_from_sample: SampleIndex,
  max_frame_bytes: Schema.Number.pipe(Schema.int(), Schema.positive()),
});

export const RejectedMessage = Schema.TaggedStruct('rejected', {
  reason: Schema.Literal('unauthorized', 'stale_generation', 'invalid_start', 'epoch_closed', 'protocol_error'),
  message: Schema.String,
});

/** Accepted for live processing only; never evidence that audio is saved in R2. */
export const AckMessage = Schema.TaggedStruct('ack', {
  sequence: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  sample_end: SampleIndex,
});

/** Live ASR cannot keep up or is down; the range is recovered later from uploaded recordings. */
export const DegradedMessage = Schema.TaggedStruct('degraded', {
  reason: Schema.Literal('asr_backlog', 'provider_unavailable'),
  from_sample: SampleIndex,
});

/** Transcript text for display; `partial` segments are never committed facts. */
export const TranscriptMessage = Schema.TaggedStruct('transcript', {
  segment: TranscriptSegment,
});

export const ServerControlMessage = Schema.Union(AcceptedMessage, RejectedMessage, AckMessage, DegradedMessage, TranscriptMessage);
export type ServerControlMessage = typeof ServerControlMessage.Type;
