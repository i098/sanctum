import { createHash } from 'node:crypto';
import { syntheticPcm } from '@sanctum/contracts/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { PcmBlockWriter, type WorkletMessage } from '../src/lib/capture/recording-worklet.ts';
import { ChunkAssembler, StorageError, type ChunkStore, type PartRecord, type SealedChunk } from '../src/lib/capture/recorder.ts';

const RATE = 48_000;
const QUANTUM = 128;
const EPOCH = { listenerId: '6a1c1d5e-3a57-4e0e-9f32-6c1c8f1f1a01', epochId: '6a1c1d5e-3a57-4e0e-9f32-6c1c8f1f1a02', sampleRate: RATE, startedAtMs: Date.UTC(2026, 8, 29, 9) };

const toFloat = (pcm: Int16Array) => Float32Array.from(pcm, (sample) => (sample < 0 ? sample / 0x8000 : sample / 0x7fff));

function feed(writer: PcmBlockWriter, input: Float32Array): void {
  for (let offset = 0; offset < input.length; offset += QUANTUM) writer.write(input.subarray(offset, offset + QUANTUM));
}

function parseWav(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const dataBytes = view.getUint32(40, true);
  return {
    tags: [text(0), text(8), text(12), text(36)],
    riffSize: view.getUint32(4, true),
    format: [view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint32(28, true), view.getUint16(32, true), view.getUint16(34, true)],
    samples: Int16Array.from({ length: dataBytes / 2 }, (_, i) => view.getInt16(44 + i * 2, true)),
  };
}

class MemoryStore implements ChunkStore {
  readonly parts: PartRecord[] = [];
  readonly chunks: SealedChunk[] = [];
  gate: Promise<void> = Promise.resolve();
  failure: StorageError | null = null;

  async appendPart(part: PartRecord): Promise<void> {
    await this.gate;
    if (this.failure) throw this.failure;
    this.parts.push(part);
  }

  async sealChunk(chunk: SealedChunk): Promise<void> {
    await this.gate;
    this.chunks.push(chunk);
    for (let i = this.parts.length - 1; i >= 0; i--) if (this.parts[i]!.chunk_id === chunk.manifest.chunk_id) this.parts.splice(i, 1);
  }
}

function assembler(store: ChunkStore, chunkSeconds: number, commitSeconds: number) {
  const errors: StorageError[] = [];
  const sealed: string[] = [];
  const instance = new ChunkAssembler(EPOCH, store, {
    chunkSamples: RATE * chunkSeconds,
    commitSamples: RATE * commitSeconds,
    onSealed: (manifest) => sealed.push(manifest.chunk_id),
    onError: (error) => errors.push(error),
  });
  return { instance, errors, sealed };
}

describe('recording worklet block writer', () => {
  it('delivers every fixture sample exactly once with a contiguous sample clock', () => {
    const fixture = syntheticPcm({ sampleRate: RATE, seconds: 1.013, toneHz: 440 });
    const received: number[] = [];
    let expectedStart = 0;
    const writer: PcmBlockWriter = new PcmBlockWriter(RATE / 20, 4, (message: WorkletMessage) => {
      if (message.type !== 'block') return;
      expect(message.sampleStart).toBe(expectedStart);
      received.push(...message.samples.subarray(0, message.count));
      expectedStart += message.count;
      writer.release(message.samples);
    });
    feed(writer, toFloat(fixture));
    writer.flush();
    expect(received).toHaveLength(fixture.length);
    expect(Int16Array.from(received)).toEqual(fixture);
  });

  it('never rewrites a block before the consumer returns it, and keeps the clock across drops', () => {
    const blocks: Array<{ sampleStart: number; samples: Int16Array; copy: Int16Array; transfer: Transferable[] }> = [];
    const writer = new PcmBlockWriter(QUANTUM, 2, (message, transfer = []) => {
      if (message.type === 'block') blocks.push({ sampleStart: message.sampleStart, samples: message.samples, copy: message.samples.slice(), transfer });
    });
    const ramp = toFloat(Int16Array.from({ length: QUANTUM * 5 }, (_, i) => i));
    feed(writer, ramp.subarray(0, QUANTUM * 4));
    expect(blocks.map((block) => block.sampleStart)).toEqual([0, QUANTUM]);
    expect(blocks.every((block) => block.transfer[0] === block.samples.buffer)).toBe(true);
    expect(blocks.map((block) => block.samples)).toEqual(blocks.map((block) => block.copy));

    writer.release(blocks[0]!.samples);
    feed(writer, ramp.subarray(QUANTUM * 4));
    expect(blocks).toHaveLength(3);
    expect(blocks[2]!.sampleStart).toBe(QUANTUM * 4);
    expect(blocks[1]!.samples).toEqual(blocks[1]!.copy);
  });
});

describe('chunk assembler', () => {
  it('produces independent valid WAV chunks whose manifests cover the fixture exactly', async () => {
    const fixture = syntheticPcm({ sampleRate: RATE, seconds: 5.5, toneHz: 1_000 });
    const store = new MemoryStore();
    const { instance, errors, sealed } = assembler(store, 2, 1);
    for (let offset = 0; offset < fixture.length; offset += 2_400) instance.write(offset, fixture.subarray(offset, offset + 2_400));
    await instance.close();

    expect(errors).toEqual([]);
    expect(store.parts).toEqual([]);
    expect(store.chunks.map(({ manifest }) => [manifest.sequence, manifest.sample_start, manifest.sample_count])).toEqual([
      [0, 0, 96_000],
      [1, 96_000, 96_000],
      [2, 192_000, 72_000],
    ]);
    expect(sealed).toEqual(store.chunks.map(({ manifest }) => manifest.chunk_id));
    for (const { manifest, wav } of store.chunks) {
      const parsed = parseWav(wav);
      expect(parsed.tags).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
      expect(parsed.riffSize).toBe(wav.length - 8);
      expect(parsed.format).toEqual([1, 1, RATE, RATE * 2, 2, 16]);
      expect(parsed.samples).toEqual(fixture.subarray(manifest.sample_start, manifest.sample_start + manifest.sample_count));
      expect(manifest.byte_length).toBe(wav.length);
      expect(manifest.sha256).toBe(createHash('sha256').update(wav).digest('hex'));
      expect(manifest.captured_at).toBe(new Date(EPOCH.startedAtMs + (manifest.sample_start / RATE) * 1000).toISOString());
    }
  });

  it('commits about every commit interval so a closed page leaves recoverable parts', async () => {
    const store = new MemoryStore();
    const { instance } = assembler(store, 30, 2);
    const fixture = syntheticPcm({ sampleRate: RATE, seconds: 5, toneHz: 300 });
    for (let offset = 0; offset < fixture.length; offset += 2_400) instance.write(offset, fixture.subarray(offset, offset + 2_400));
    await vi.waitFor(() => expect(store.parts).toHaveLength(2));
    expect(store.parts.map((part) => [part.part_start, part.samples.length])).toEqual([
      [0, 96_000],
      [96_000, 96_000],
    ]);
    expect(store.chunks).toEqual([]);
  });

  it('seals early at a sample-clock discontinuity instead of shifting later audio', async () => {
    const store = new MemoryStore();
    const { instance } = assembler(store, 30, 2);
    instance.write(0, new Int16Array(4_800).fill(1));
    instance.write(4_800 + 9_600, new Int16Array(4_800).fill(2));
    await instance.close();
    expect(store.chunks.map(({ manifest }) => [manifest.sample_start, manifest.sample_count])).toEqual([
      [0, 4_800],
      [14_400, 4_800],
    ]);
  });

  it('does not reuse a chunk array while its write is still pending', async () => {
    const store = new MemoryStore();
    let open = () => { };
    store.gate = new Promise((resolve) => (open = resolve));
    const { instance } = assembler(store, 1, 1);
    instance.write(0, new Int16Array(RATE).fill(7));
    instance.write(RATE, new Int16Array(RATE / 2).fill(9));
    open();
    await instance.close();
    expect(parseWav(store.chunks[0]!.wav).samples.every((sample) => sample === 7)).toBe(true);
    expect(parseWav(store.chunks[1]!.wav).samples.every((sample) => sample === 9)).toBe(true);
  });

  it('reports a full store once and stops accepting audio', async () => {
    const store = new MemoryStore();
    store.failure = new StorageError('full');
    const { instance, errors } = assembler(store, 30, 0.1);
    instance.write(0, new Int16Array(RATE));
    await instance.close();
    expect(errors.map((error) => error.kind)).toEqual(['full']);
  });

  it('bounds queued writes when storage stalls', async () => {
    const store = new MemoryStore();
    store.gate = new Promise(() => { });
    const { instance, errors } = assembler(store, 30, 0.05);
    for (let offset = 0; offset < RATE; offset += 2_400) instance.write(offset, new Int16Array(2_400));
    expect(errors.map((error) => error.kind)).toEqual(['unavailable']);
  });
});
