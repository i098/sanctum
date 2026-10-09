import type { Page } from '@playwright/test';
import type { ActionUpdateMessage } from '@sanctum/contracts';
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
const transcriptListeners = new Set();
const actionListeners = new Set();
let segments = 0;
const fake = {
  calls: [], reads: 0, gain: null,
  update: patch => store.update(patch),
  setGain: value => { fake.gain.gain.value = value; },
  transcript: (text, speaker = null, status = 'final') => {
    const at = segments++ * 48000;
    const segment = { id: 'segment-' + segments, source: { epoch_id: 'epoch-1', track: 0, sample_start: at, sample_end: at + 48000 }, text, status, revision: 1, origin: 'live', provider: 'fake', model: 'fake', provider_connection_id: null, speaker_label: speaker, speaker_track_id: null, confidence: 0.9, created_at: new Date().toISOString() };
    transcriptListeners.forEach(listener => listener(segment));
  },
  actions: message => actionListeners.forEach(listener => listener({ _tag: 'action_update', ...message })),
};
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
export function subscribeTranscript(listener) { transcriptListeners.add(listener); return () => transcriptListeners.delete(listener); }
export function subscribeActions(listener) { actionListeners.add(listener); return () => actionListeners.delete(listener); }
`;

interface FakeCapture {
  calls: string[];
  reads: number;
  update(patch: Partial<CaptureSnapshot>): void;
  setGain(value: number): void;
  /** Delivers one live transcript segment, as the listener stream would. */
  transcript(text: string, speaker?: string | null, status?: 'partial' | 'final'): void;
  /** Delivers one `action_update`, as the listener stream would after a (re)connect or an action change. */
  actions(message: Omit<typeof ActionUpdateMessage.Encoded, '_tag'>): void;
}

/** Test-side stand-in for the browser's speech recognition (Web Speech API). */
interface FakeSpeech {
  /** Recognition sessions started so far. */
  starts: number;
  /** Delivers the words of the current utterance; a final result closes it. */
  say(text: string, final?: boolean): void;
  /** Ends the session as the browser does on its own, or with `error` as it does on failure. */
  end(error?: string): void;
}

declare global {
  interface Window {
    __capture: FakeCapture;
    __speech: FakeSpeech;
  }
}

interface Result {
  isFinal: boolean;
  0: { transcript: string };
}

/** Replaces the browser's recognition with `FakeSpeech`, or removes it (as in Firefox). Runs in the page. */
function installSpeech(fake: boolean): void {
  Reflect.deleteProperty(window, 'SpeechRecognition');
  Reflect.deleteProperty(window, 'webkitSpeechRecognition');
  if (!fake) return;
  let current: { onstart: (() => void) | null; onresult: ((event: { resultIndex: number; results: Result[] }) => void) | null; onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null } | null = null;
  let results: Result[] = [];
  class FakeRecognition {
    onstart = null;
    onresult = null;
    onerror = null;
    onend = null;
    start(): void {
      current = this;
      results = [];
      window.__speech.starts++;
      queueMicrotask(() => current?.onstart?.());
    }
    abort(): void {
      current = null;
    }
  }
  window.__speech = {
    starts: 0,
    say(text, final = false) {
      if (results.at(-1)?.isFinal === false) results.pop();
      results.push({ isFinal: final, 0: { transcript: text } });
      current?.onresult?.({ resultIndex: results.length - 1, results });
    },
    end(error) {
      if (error !== undefined) current?.onerror?.({ error });
      current?.onend?.();
    },
  };
  Object.defineProperty(window, 'webkitSpeechRecognition', { value: FakeRecognition, configurable: true });
}

/** What the fake server says about sign-in: `/auth/config` and `GET /api/v1/session`. */
export interface FakeSignIn {
  /** `'unavailable'` answers `/auth/config` with a 503. */
  configured: boolean | 'unavailable';
  /** The session body, or `null` for a 401. */
  access: object | null;
  /** `self_serve_workspaces` in `/auth/config`. */
  selfServe?: boolean;
}

/** `FakeSignIn` is read on every request, so a spec may change it mid-test. */
export type ListenOptions = Partial<FakeSignIn> & { speech?: boolean };

/**
 * Serves the listening page on the fake engine. The sign-in fields are read on every request.
 * The waveform lays out its slots with Math.random once per mount, so the page gets a fixed PRNG:
 * the pixel-measuring specs then see the same layout every run instead of a random one.
 * The browser has no speech recognition unless `speech` installs `FakeSpeech`.
 */
export async function serveListening(page: Page, options: ListenOptions = {}): Promise<void> {
  await page.addInitScript(() => {
    let state = 42;
    Math.random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  });
  await page.addInitScript(installSpeech, options.speech ?? false);
  await page.route('**/src/pages/listen/engine.ts*', route =>
    route.fulfill({ contentType: 'text/javascript', body: FAKE_ENGINE }));
  await page.route('**/auth/config', route => options.configured === 'unavailable'
    ? route.fulfill({ status: 503, json: { message: 'upstream down' } })
    : route.fulfill({ json: { sign_in: options.configured ?? false, embedded_issuer: null, self_serve_workspaces: options.selfServe ?? false } }));
  await page.route('**/api/v1/session', route => route.fulfill(options.access
    ? { json: options.access }
    : { status: 401, json: { _tag: 'Unauthenticated', code: 'unauthenticated', message: 'No credentials' } }));
}

/** Opens the listening page on the fake engine and starts listening in silence. */
export async function openListening(page: Page, options?: ListenOptions): Promise<void> {
  await serveListening(page, options);
  await page.goto('/');
  await page.getByRole('button', { name: 'Listen' }).click();
  await page.getByText('listening', { exact: true }).waitFor();
}

/** Opens a meeting, started 10:02 UTC, on the listener as the stream does: an `action_update` naming it, then the page's read of it. */
export async function openMeeting(page: Page, id: string, title: string | null): Promise<void> {
  const processing = { transcript: 'pending', notes: 'pending', memory: 'pending', recording: 'pending' };
  const meeting = { id, workspace_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', state: 'active', title, started_at: '2026-09-28T10:02:00.000Z', ended_at: null, timezone: 'UTC', boundary_revision: 1, visibility: 'restricted', processing };
  await page.route(`**/api/v1/meetings/${id}`, route => route.fulfill({ json: meeting }));
  await page.evaluate(meeting_id => window.__capture.actions({ meeting_id, actions: [] }), id);
}

export interface WaveProfile {
  /** CSS px above / below the baseline reached by wave-coloured pixels. */
  rise: number;
  fall: number;
  /** Page CSS px. */
  baseline: number;
  left: number;
  right: number;
  /** Separate column runs rising above half the tallest column: the needles standing out of the ink. */
  needles: number;
  /** Page y of the highest ink in each page-x CSS column; the baseline where a column has none. */
  tops: number[];
}

/** Scans the waveform canvas for pale wave ink (not the darker glow). */
export function waveProfile(page: Page): Promise<WaveProfile> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const box = canvas.getBoundingClientRect();
    const ratio = canvas.width / box.width;
    const { data, width, height } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    const ink = (x: number, y: number): boolean => (data[(y * width + x) * 4] ?? 0) > 100;
    const columns = Array.from({ length: width }, (_, x) => x);
    const rows = Array.from({ length: height }, (_, y) => columns.filter(x => ink(x, y)).length);
    const baseline = rows.indexOf(Math.max(...rows));
    /** Ink pixels running from the baseline in direction `dy` in column `x`, stopping at the canvas edge. */
    const reach = (x: number, dy: number): number => {
      let y = baseline;
      while (y + dy >= 0 && y + dy < height && ink(x, y + dy)) y += dy;
      return Math.abs(y - baseline);
    };
    const above = columns.map(x => reach(x, -1));
    const rise = Math.max(...above);
    const tall = (columnHeight = 0): boolean => columnHeight > rise / 2 && columnHeight > 4 * ratio;
    const onLine = columns.filter(x => ink(x, baseline));
    return {
      rise: rise / ratio,
      fall: Math.max(...columns.map(x => reach(x, 1))) / ratio,
      baseline: box.top + baseline / ratio,
      left: box.left + onLine[0]! / ratio,
      right: box.left + onLine.at(-1)! / ratio,
      needles: above.filter((columnHeight, x) => tall(columnHeight) && !tall(above[x - 1])).length,
      tops: Array.from({ length: Math.round(width / ratio) }, (_, column) => box.top + (baseline - above[Math.round(column * ratio)]!) / ratio),
    };
  });
}
