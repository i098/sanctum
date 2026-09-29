import { describe, expect, it } from 'vitest';
import { drawWaveform } from '../src/pages/listen/waveform.ts';

const BASELINE = 316;

/** Records the path drawWaveform builds on a 1280 × 720 canvas. */
function record(bands: Float32Array, state: 'listening' | 'paused' = 'listening', reducedMotion = false) {
  const needles: Array<{ x: number; rise: number; fall: number }> = [];
  const points: Array<[number, number]> = [];
  const baseline: number[] = [];
  const context = {
    canvas: { width: 1280, height: 720 },
    globalAlpha: 1,
    shadowBlur: 0,
    getTransform: () => ({ a: 1 }),
    clearRect() {},
    beginPath() {},
    fill() {},
    rect: (x: number, y: number, width: number, height: number) => baseline.push(x, y, width, height),
    moveTo: (x: number, y: number) => points.splice(0, points.length, [x, y]),
    lineTo: (x: number, y: number) => points.push([x, y]),
    closePath() {
      const ys = points.map(([, y]) => y);
      needles.push({ x: points[2]![0], rise: BASELINE - Math.min(...ys), fall: Math.max(...ys) - BASELINE });
    },
  };
  drawWaveform(context as unknown as CanvasRenderingContext2D, bands, state, reducedMotion);
  return { needles, baseline, alpha: context.globalAlpha, blur: context.shadowBlur };
}

describe('drawWaveform', () => {
  it('draws silence as a thin 760 px baseline at the reference height', () => {
    const { needles, baseline } = record(new Float32Array(33));
    expect(baseline).toEqual([260, BASELINE - 1, 760, 2]);
    expect(needles).toHaveLength(33);
    expect(needles.every(needle => needle.rise === 0 && needle.fall === 0)).toBe(true);
  });

  it('draws irregular needles with a shorter, uneven underside that fade toward the edges', () => {
    const { needles } = record(new Float32Array(33).fill(1));
    const ratios = needles.map(needle => needle.fall / needle.rise);
    expect(Math.max(...needles.map(needle => needle.rise))).toBeLessThanOrEqual(0.2 * 720);
    expect(ratios.every(ratio => ratio >= 0.35 && ratio <= 0.75)).toBe(true);
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeGreaterThan(0.2);
    expect(needles[0]!.rise).toBeLessThan(needles[16]!.rise / 2);
    expect(needles[32]!.rise).toBeLessThan(needles[16]!.rise / 2);
    const gaps = needles.slice(1).map((needle, index) => needle.x - needles[index]!.x);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(5);
  });

  it('places the lowest band mid-screen and ignores room noise below the floor', () => {
    const bands = new Float32Array(33).fill(0.25);
    bands[0] = 1;
    const loud = record(bands).needles.filter(needle => needle.rise > 0);
    expect(loud).toHaveLength(1);
    expect(Math.abs(loud[0]!.x - 640)).toBeLessThan(760 / 33);
  });

  it('limits amplitude under reduced motion and dims states without live levels', () => {
    const bands = new Float32Array(33).fill(1);
    const full = record(bands).needles[16]!.rise;
    expect(record(bands, 'listening', true).needles[16]!.rise).toBeCloseTo(full * 0.45);
    expect(record(bands)).toMatchObject({ alpha: 1, blur: 12 });
    expect(record(bands, 'paused')).toMatchObject({ alpha: 0.45, blur: 0 });
  });
});
