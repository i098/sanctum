import { describe, expect, it } from 'vitest';
import { createNoiseFloor } from '../src/pages/listen/waveform.ts';

const BANDS = 8;
const FRAME_S = 1 / 60;
/** Steady room noise on the analyser's 0..1 dB scale: 0.4 with a frame-to-frame flutter of ±0.03. */
const noise = (frame: number, band: number): number => 0.4 + 0.03 * Math.sin(frame * 1.7 + band * 2.3);

function settledOnNoise(): { calm: (bands: Float32Array, seconds: number) => void; bands: Float32Array; frame: number } {
  const calm = createNoiseFloor(BANDS);
  const bands = new Float32Array(BANDS);
  let frame = 0;
  for (; frame < 10 * 60; frame++) {
    bands.forEach((_, band) => (bands[band] = noise(frame, band)));
    calm(bands, FRAME_S);
  }
  return { calm, bands, frame };
}

describe('createNoiseFloor', () => {
  it('draws steady room noise as a flat line once the floor has settled', () => {
    const { calm, bands, frame } = settledOnNoise();
    let loudest = 0;
    for (let f = frame; f < frame + 5 * 60; f++) {
      bands.forEach((_, band) => (bands[band] = noise(f, band)));
      calm(bands, FRAME_S);
      loudest = Math.max(loudest, ...bands);
    }
    expect(loudest).toBe(0);
  });

  it('passes a speech-level jump in one band at once and leaves the others flat', () => {
    const { calm, bands, frame } = settledOnNoise();
    bands.forEach((_, band) => (bands[band] = noise(frame, band)));
    bands[3] = 0.85;
    calm(bands, FRAME_S);
    expect(bands[3]).toBeGreaterThan(0.5);
    expect(Array.from(bands).filter((_, band) => band !== 3)).toEqual(new Array(BANDS - 1).fill(0));
  });

  it('keeps speech that comes and goes above the floor for a long monologue', () => {
    const { calm, bands, frame } = settledOnNoise();
    let quietestSyllable = 1;
    // 30 s of 200 ms syllables with 130 ms gaps of room noise between them.
    for (let f = frame; f < frame + 30 * 60; f++) {
      const syllable = (f - frame) % 20 < 12;
      bands.forEach((_, band) => (bands[band] = syllable ? 0.85 : noise(f, band)));
      calm(bands, FRAME_S);
      if (syllable) quietestSyllable = Math.min(quietestSyllable, ...bands);
    }
    expect(quietestSyllable).toBeGreaterThan(0.5);
  });

  it('learns a new, louder steady noise within eight seconds', () => {
    const calm = createNoiseFloor(BANDS);
    const bands = new Float32Array(BANDS);
    for (let frame = 0; frame < 8 * 60; frame++) {
      bands.forEach((_, band) => (bands[band] = noise(frame, band) + 0.3));
      calm(bands, FRAME_S);
    }
    expect(Math.max(...bands)).toBe(0);
  });
});
