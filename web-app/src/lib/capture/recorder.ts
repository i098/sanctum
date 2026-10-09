/**
 * Microphone tap (plan 05 "Browser recovery buffer"): one Web Audio graph feeds the waveform
 * analyser and the recording worklet; PCM blocks become independent PCM16 WAV chunks whose
 * sample positions come from the worklet's sample clock, never from wall-clock subtraction.
 */
import { RecordingChunkManifest } from '@sanctum/contracts';
import { Schema } from 'effect';
import { createAnalyserLevels } from './levels.ts';
import type { LevelSource } from './view.ts';
import { RECORDER_PROCESSOR, type MainMessage, type WorkletMessage } from './recording-worklet.ts';
import workletUrl from './recording-worklet.ts?worker&url';

export const WAV_HEADER_BYTES = 44;
/** Roughly 33 irregular waveform regions (docs/DESIGN.md). */
export const WAVEFORM_BANDS = 33;
/** Queued part/seal writes before storage counts as stalled; bounds retained chunk memory. */
const MAX_QUEUED_WRITES = 8;

export type StorageFailure = 'full' | 'unavailable';

export class StorageError extends Error {
  readonly kind: StorageFailure;
  constructor(kind: StorageFailure, cause?: unknown) {
    super(`recovery storage ${kind}`, { cause });
    this.kind = kind;
  }
}

/** One committed slice (about two seconds) of the chunk still being recorded. */
export interface PartRecord {
  readonly chunk_id: string;
  readonly listener_id: string;
  readonly epoch_id: string;
  readonly sequence: number;
  readonly sample_rate: number;
  readonly chunk_start: number;
  readonly captured_at: string;
  readonly part_start: number;
  readonly byte_length: number;
  readonly samples: Int16Array;
}

export type ChunkHeader = Omit<PartRecord, 'part_start' | 'byte_length' | 'samples'>;

export interface SealedChunk {
  readonly manifest: RecordingChunkManifest;
  readonly wav: Uint8Array;
}

/** Durable side of the assembler; the IndexedDB recovery buffer implements it. */
export interface ChunkStore {
  appendPart(part: PartRecord): Promise<void>;
  /** Stores the complete chunk and removes its parts atomically. */
  sealChunk(chunk: SealedChunk): Promise<void>;
}

export interface EpochMeta {
  readonly listenerId: string;
  readonly epochId: string;
  readonly sampleRate: number;
  /** Wall clock (ms) of epoch sample 0. */
  readonly startedAtMs: number;
}

const decodeManifest = Schema.decodeUnknownSync(RecordingChunkManifest);

/** Mono PCM16 WAV header; RIFF sizes are 32-bit, so one file holds at most about 4 GiB of samples. */
export function wavHeader(sampleCount: number, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = sampleCount * 2;
  if (dataBytes > 0xffff_ffff - (WAV_HEADER_BYTES - 8)) throw new RangeError('audio too long for one WAV file');
  const bytes = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, dataBytes, true);
  return bytes;
}

function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(WAV_HEADER_BYTES + samples.length * 2);
  bytes.set(wavHeader(samples.length, sampleRate));
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(WAV_HEADER_BYTES + i * 2, samples[i]!, true);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Builds the WAV and its validated manifest; also used to finish chunks recovered after a reload. */
export async function sealChunk(header: ChunkHeader, samples: Int16Array): Promise<SealedChunk> {
  const wav = encodeWav(samples, header.sample_rate);
  const manifest = decodeManifest({
    chunk_id: header.chunk_id,
    listener_id: header.listener_id,
    epoch_id: header.epoch_id,
    track: 0,
    sequence: header.sequence,
    sample_start: header.chunk_start,
    sample_count: samples.length,
    sample_rate: header.sample_rate,
    captured_at: header.captured_at,
    byte_length: wav.byteLength,
    sha256: await sha256Hex(wav),
  });
  return { manifest, wav };
}

export interface AssemblerOptions {
  readonly chunkSamples: number;
  readonly commitSamples: number;
  onSealed(manifest: RecordingChunkManifest): void;
  onError(error: StorageError): void;
}

/**
 * Splits one epoch's sample stream into independent chunks. Each chunk owns a fresh array, so
 * a chunk being encoded or stored is never overwritten; queued writes are bounded.
 */
export class ChunkAssembler {
  private readonly meta: EpochMeta;
  private readonly store: ChunkStore;
  private readonly options: AssemblerOptions;
  private header: ChunkHeader | null = null;
  private chunk = new Int16Array(0);
  private filled = 0;
  private committed = 0;
  private sequence = 0;
  private queued = 0;
  private tail: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(meta: EpochMeta, store: ChunkStore, options: AssemblerOptions) {
    this.meta = meta;
    this.store = store;
    this.options = options;
  }

  write(sampleStart: number, samples: Int16Array): void {
    if (this.failed) return;
    if (this.header !== null && sampleStart !== this.header.chunk_start + this.filled) this.seal();
    let offset = 0;
    while (offset < samples.length && !this.failed) {
      if (this.header === null) this.begin(sampleStart + offset);
      const count = Math.min(samples.length - offset, this.chunk.length - this.filled);
      this.chunk.set(samples.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.chunk.length) this.seal();
      else if (this.filled - this.committed >= this.options.commitSamples) this.commitPart();
    }
  }

  /** Seals the partial chunk and resolves once every queued write settled. */
  async close(): Promise<void> {
    if (this.header !== null && this.filled > 0) this.seal();
    this.header = null;
    await this.tail;
  }

  private begin(chunkStart: number): void {
    const { listenerId, epochId, sampleRate, startedAtMs } = this.meta;
    this.header = {
      chunk_id: crypto.randomUUID(),
      listener_id: listenerId,
      epoch_id: epochId,
      sequence: this.sequence++,
      sample_rate: sampleRate,
      chunk_start: chunkStart,
      captured_at: new Date(startedAtMs + (chunkStart / sampleRate) * 1000).toISOString(),
    };
    this.chunk = new Int16Array(this.options.chunkSamples);
    this.filled = 0;
    this.committed = 0;
  }

  private commitPart(): void {
    const header = this.header!;
    const samples = this.chunk.slice(this.committed, this.filled);
    const part: PartRecord = { ...header, part_start: header.chunk_start + this.committed, byte_length: samples.byteLength, samples };
    this.committed = this.filled;
    this.enqueue(() => this.store.appendPart(part));
  }

  private seal(): void {
    const header = this.header!;
    const samples = this.chunk.subarray(0, this.filled);
    this.header = null;
    this.enqueue(async () => {
      const sealed = await sealChunk(header, samples);
      await this.store.sealChunk(sealed);
      this.options.onSealed(sealed.manifest);
    });
  }

  private enqueue(write: () => Promise<void>): void {
    if (++this.queued > MAX_QUEUED_WRITES) return this.fail(new StorageError('unavailable'));
    this.tail = this.tail.then(write).then(
      () => void this.queued--,
      (error: unknown) => this.fail(error instanceof StorageError ? error : new StorageError('unavailable', error)),
    );
  }

  private fail(error: StorageError): void {
    if (this.failed) return;
    this.failed = true;
    this.options.onError(error);
  }
}

export interface Recorder {
  readonly sampleRate: number;
  readonly levels: LevelSource;
  /** Resolves after every sample captured so far reached `onBlock`. */
  flush(): Promise<void>;
  /** Feeds `stream` instead of the current input; the sample clock and the epoch go on without a gap. */
  replaceInput(stream: MediaStream): void;
  close(): Promise<void>;
}

/** Connects `stream` to the analyser and recording worklet on one AudioContext. */
export async function startRecorder(stream: MediaStream, onBlock: (sampleStart: number, samples: Int16Array) => void): Promise<Recorder> {
  const context = new AudioContext({ latencyHint: 'interactive' });
  try {
    await context.audioWorklet.addModule(workletUrl);
    let source = context.createMediaStreamSource(stream);
    // Spectral smoothing for the waveform only; the worklet still gets every sample unchanged.
    const analyser = new AnalyserNode(context, { fftSize: 2048, smoothingTimeConstant: 0.7 });
    const node = new AudioWorkletNode(context, RECORDER_PROCESSOR, { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
    // The worklet writes no output; the destination link keeps the graph pulled in every browser.
    source.connect(analyser).connect(node).connect(context.destination);
    let flushed: (() => void) | null = null;
    const send = (message: MainMessage, transfer: Transferable[] = []) => node.port.postMessage(message, transfer);
    node.port.onmessage = ({ data }: MessageEvent<WorkletMessage>) => {
      if (data.type === 'block') {
        onBlock(data.sampleStart, data.samples.subarray(0, data.count));
        send({ type: 'release', samples: data.samples }, [data.samples.buffer]);
      } else flushed?.();
    };
    // A suspended or closed context never answers, and has no unflushed samples to wait for.
    const flush = () =>
      context.state !== 'running'
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            flushed = resolve;
            send({ type: 'flush' });
          });
    return {
      sampleRate: context.sampleRate,
      levels: createAnalyserLevels(analyser, WAVEFORM_BANDS),
      flush,
      replaceInput(next) {
        const created = context.createMediaStreamSource(next);
        source.disconnect();
        source = created;
        source.connect(analyser);
      },
      async close() {
        await flush();
        source.disconnect();
        node.port.close();
        await context.close();
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}
