import type { Page } from '@playwright/test';
import type { CaptureSnapshot } from '../src/lib/capture/view.ts';

/**
 * Test-side stand-in for the capture engine, served in place of `engine.ts`.
 * Levels come from real Web Audio: a square-wave oscillator through an AnalyserNode and the
 * production `createAnalyserLevels`, silenced by default and made loud with `setGain`.
 */
const FAKE_ENGINE = `
import { createCaptureStore } from '/src/lib/capture/view.ts';
import { createAnalyserLevels } from '/src/lib/capture/levels.ts';
const store = createCaptureStore();
const fake = { calls: [], reads: 0, gain: null, update: patch => store.update(patch), setGain: value => { fake.gain.gain.value = value; } };
window.__capture = fake;
let levels = null;
const engine = {
  ...store.view,
  levels: { bandCount: 33, read(bands) { fake.reads++; if (levels) return levels.read(bands); bands.fill(0); return 0; } },
  async start() {
    fake.calls.push('start');
    const context = new AudioContext();
    const oscillator = new OscillatorNode(context, { type: 'square', frequency: 220 });
    fake.gain = new GainNode(context, { gain: 0 });
    const analyser = new AnalyserNode(context, { fftSize: 2048, smoothingTimeConstant: 0 });
    oscillator.connect(fake.gain).connect(analyser).connect(new GainNode(context, { gain: 0 })).connect(context.destination);
    oscillator.start();
    await context.resume();
    levels = createAnalyserLevels(analyser, 33);
    store.update({ listener: 'listening', permission: 'granted', archive: 'capturing' });
  },
  async pause() { fake.calls.push('pause'); store.update({ listener: 'paused' }); },
  async resume() { fake.calls.push('resume'); store.update({ listener: 'listening' }); },
  async orphanedRecordings() { return []; },
  async exportRecording() { return null; },
  async discardRecording() {},
};
export function getCaptureEngine() { return engine; }
`;

interface FakeCapture {
  calls: string[];
  reads: number;
  update(patch: Partial<CaptureSnapshot>): void;
  setGain(value: number): void;
}

declare global {
  interface Window {
    __capture: FakeCapture;
  }
}

/** Opens the listening page on the fake engine and starts listening in silence. */
export async function openListening(page: Page): Promise<void> {
  await page.route('**/src/pages/listen/engine.ts*', route =>
    route.fulfill({ contentType: 'text/javascript', body: FAKE_ENGINE }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Listen' }).click();
  await page.getByText('listening', { exact: true }).waitFor();
}

export interface WaveProfile {
  /** CSS px above / below the baseline reached by wave-coloured pixels. */
  rise: number;
  fall: number;
  baseline: number;
  left: number;
  right: number;
  /** Separate columns runs rising more than 4 px: the visible needles. */
  needles: number;
  /** Most opaque wave pixel on the baseline row, 0..255. */
  brightness: number;
}

/** Scans the waveform canvas for pale wave ink (not the darker blue glow). */
export function waveProfile(page: Page): Promise<WaveProfile> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const ratio = canvas.width / canvas.clientWidth;
    const { data, width, height } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    const ink = (x: number, y: number): number => {
      const at = (y * width + x) * 4;
      return (data[at] ?? 0) > 100 ? (data[at + 3] ?? 0) : 0;
    };
    const rows = Array.from({ length: height }, (_, y) => {
      let count = 0;
      for (let x = 0; x < width; x++) if (ink(x, y)) count++;
      return count;
    });
    const baseline = rows.indexOf(Math.max(...rows));
    let left = width, right = 0, top = baseline, bottom = baseline, needles = 0, inNeedle = false, brightness = 0;
    for (let x = 0; x < width; x++) {
      brightness = Math.max(brightness, ink(x, baseline));
      if (ink(x, baseline)) { left = Math.min(left, x); right = Math.max(right, x); }
      let columnTop = baseline;
      while (columnTop > 0 && ink(x, columnTop - 1)) columnTop--;
      let columnBottom = baseline;
      while (columnBottom < height - 1 && ink(x, columnBottom + 1)) columnBottom++;
      top = Math.min(top, columnTop);
      bottom = Math.max(bottom, columnBottom);
      const tall = baseline - columnTop > 4 * ratio;
      if (tall && !inNeedle) needles++;
      inNeedle = tall;
    }
    return {
      rise: (baseline - top) / ratio,
      fall: (bottom - baseline) / ratio,
      baseline: baseline / ratio,
      left: left / ratio,
      right: right / ratio,
      needles,
      brightness,
    };
  });
}
