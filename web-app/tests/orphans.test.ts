import { describe, expect, it } from 'vitest';
import { assembleWav, groupRecordings, type RecordingSegment } from '../src/lib/capture/orphans.ts';
import { sealChunk, WAV_HEADER_BYTES, type SealedChunk } from '../src/lib/capture/recorder.ts';

const RATE = 16_000;
const LISTENER = '6a1c1d5e-3a57-4e0e-9f32-6c1c8f1f1a01';
const EPOCH = '6a1c1d5e-3a57-4e0e-9f32-6c1c8f1f1a02';
const LATER_EPOCH = '6a1c1d5e-3a57-4e0e-9f32-6c1c8f1f1a03';
const EPOCH_START = Date.UTC(2026, 8, 29, 9);

/** A chunk whose sample values are their epoch sample positions, so order is visible in the file. */
function chunk(sequence: number, start: number, count: number, epoch = EPOCH) {
  const samples = Int16Array.from({ length: count }, (_, index) => (start + index) % 32_768);
  const captured_at = new Date(EPOCH_START + (epoch === EPOCH ? 0 : 3_600_000) + (start / RATE) * 1000).toISOString();
  return sealChunk({ chunk_id: crypto.randomUUID(), listener_id: LISTENER, epoch_id: epoch, sequence, sample_rate: RATE, chunk_start: start, captured_at }, samples);
}

const segment = ({ manifest, wav }: SealedChunk): RecordingSegment => ({ sampleStart: manifest.sample_start, sampleCount: manifest.sample_count, data: new Blob([wav.subarray(WAV_HEADER_BYTES) as Uint8Array<ArrayBuffer>]) });

/** Header fields and samples of one exported WAV file. */
async function readWav(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  return {
    tags: [text(0), text(8), text(12), text(36)],
    riffSize: view.getUint32(4, true),
    format: [view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint32(28, true), view.getUint16(32, true), view.getUint16(34, true)],
    dataBytes: view.getUint32(40, true),
    length: bytes.length,
    samples: Array.from(new Int16Array(bytes.buffer, WAV_HEADER_BYTES)),
  };
}

const positions = (start: number, count: number) => Array.from({ length: count }, (_, index) => (start + index) % 32_768);

describe('orphaned local recordings', () => {
  it('groups chunks per listener and epoch with start, kept length and gaps from the sample clock', async () => {
    const chunks = await Promise.all([chunk(3, 3 * RATE, RATE), chunk(1, RATE, RATE), chunk(0, 0, RATE, LATER_EPOCH), chunk(0, 0, RATE)]);
    const [first, second] = groupRecordings(chunks.map(({ manifest }) => manifest));
    expect(first).toEqual({
      listenerId: LISTENER,
      epochId: EPOCH,
      sampleRate: RATE,
      startedAt: '2026-09-29T09:00:00.000Z',
      sampleCount: 3 * RATE,
      chunkCount: 3,
      gaps: [{ at: 2 * RATE, missing: RATE }],
    });
    expect(second).toMatchObject({ epochId: LATER_EPOCH, startedAt: '2026-09-29T10:00:00.000Z', sampleCount: RATE, gaps: [] });
  });

  it('assembles one valid WAV in sample order without filling the gap', async () => {
    const chunks = await Promise.all([chunk(3, 3 * RATE, RATE), chunk(0, 0, RATE), chunk(1, RATE, RATE)]);
    const parts = assembleWav(chunks.map(segment), RATE);
    expect(parts.map(({ sampleStart, sampleEnd }) => [sampleStart, sampleEnd])).toEqual([[0, 4 * RATE]]);
    const wav = await readWav(parts[0]!.blob);
    expect(wav.tags).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(wav.riffSize).toBe(wav.length - 8);
    expect(wav.format).toEqual([1, 1, RATE, RATE * 2, 2, 16]);
    expect(wav.dataBytes).toBe(3 * RATE * 2);
    expect(wav.samples).toEqual([...positions(0, 2 * RATE), ...positions(3 * RATE, RATE)]);
  });

  it('splits a recording over the WAV size limit into sequential standard WAV files', async () => {
    const chunks = await Promise.all([chunk(0, 0, RATE), chunk(1, RATE, RATE), chunk(3, 3 * RATE, RATE)]);
    const limit = (5 * RATE) / 4;
    const parts = assembleWav(chunks.map(segment), RATE, limit);
    expect(parts.map(({ sampleStart, sampleEnd }) => [sampleStart, sampleEnd])).toEqual([
      [0, limit],
      [limit, 3 * RATE + RATE / 2],
      [3 * RATE + RATE / 2, 4 * RATE],
    ]);
    const wavs = await Promise.all(parts.map((part) => readWav(part.blob)));
    for (const wav of wavs) {
      expect(wav.tags).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
      expect(wav.riffSize).toBe(wav.length - 8);
      expect(wav.dataBytes).toBe(wav.samples.length * 2);
      expect(wav.samples.length).toBeLessThanOrEqual(limit);
    }
    expect(wavs.flatMap((wav) => wav.samples)).toEqual([...positions(0, 2 * RATE), ...positions(3 * RATE, RATE)]);
  });
});
