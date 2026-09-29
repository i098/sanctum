import { describe, expect, it } from 'vitest';
import { assembleWav, groupRecordings } from '../src/lib/capture/orphans.ts';
import { sealChunk } from '../src/lib/capture/recorder.ts';

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
    const bytes = new Uint8Array(await assembleWav(chunks).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    expect([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint32(28, true), view.getUint16(32, true), view.getUint16(34, true)]).toEqual([1, 1, RATE, RATE * 2, 2, 16]);
    expect(view.getUint32(40, true)).toBe(3 * RATE * 2);
    const samples = new Int16Array(bytes.buffer, 44);
    expect(samples.length).toBe(3 * RATE);
    const expected = Int16Array.from([...Array(2 * RATE).keys(), ...Array.from({ length: RATE }, (_, index) => (3 * RATE + index) % 32_768)]);
    expect(Buffer.from(samples.buffer, 44).equals(Buffer.from(expected.buffer))).toBe(true);
  });
});
