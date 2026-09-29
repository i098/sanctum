/**
 * Fullscreen waveform (docs/DESIGN.md "Waveform geometry" and "Motion").
 * Plain typed-array code driven by requestAnimationFrame; samples never enter React state.
 */
import type { LevelSource, ListenerState } from '../../lib/capture/view.ts';

const WAVE = '#b9c4f9';
const GLOW = 'rgba(61, 125, 255, 0.55)';
/** Geometry as fractions of the viewport, measured from the 1280 × 720 reference. */
const SPAN = 760 / 1280;
const BASELINE = 316 / 720;
const MAX_RISE = 0.2;
/** Band energy below this reads as room noise, so a quiet room stays a thin line. Calibration knob. */
const NOISE_FLOOR = 0.3;
const ATTACK_MS = 25;
const RELEASE_MS = 420;
const REDUCED_FRAME_MS = 250;
const REDUCED_SCALE = 0.45;

/** States with real microphone levels; every other state settles to a subdued line. */
const LIVE: Record<ListenerState, boolean> = {
  listening: true,
  degraded: true,
  stopped: false,
  starting: false,
  reconnecting: false,
  paused: false,
};

/** Deterministic 0..1 value per region and salt, so the irregular shape is stable between frames. */
function jitter(region: number, salt: number): number {
  const x = Math.sin(region * 127.1 + salt * 311.7) * 43_758.5453;
  return x - Math.floor(x);
}

/** Quick attack, slow release: moves `display` toward `target` for `elapsedMs` of wall time. */
function followEnvelope(display: Float32Array, target: Float32Array, elapsedMs: number): void {
  const attack = 1 - Math.exp(-elapsedMs / ATTACK_MS);
  const release = 1 - Math.exp(-elapsedMs / RELEASE_MS);
  for (let i = 0; i < display.length; i++) {
    const from = display[i]!;
    const to = target[i]!;
    display[i] = from + (to - from) * (to > from ? attack : release);
  }
}

function traceNeedle(context: CanvasRenderingContext2D, x: number, y: number, base: number, rise: number, fall: number): void {
  const shoulder = base * 0.4;
  context.moveTo(x - base, y);
  context.lineTo(x - shoulder, y - rise * 0.08);
  context.lineTo(x, y - rise);
  context.lineTo(x + shoulder, y - rise * 0.08);
  context.lineTo(x + base, y);
  context.lineTo(x + shoulder, y + fall * 0.08);
  context.lineTo(x, y + fall);
  context.lineTo(x - shoulder, y + fall * 0.08);
  context.closePath();
}

/**
 * Adds the baseline and one irregular needle region per band to the current path.
 * Low, speech-heavy bands sit mid-screen and higher bands alternate outward, so energy gathers
 * away from the edges. The underside is a per-region fraction of the peak.
 */
function traceRegions(context: CanvasRenderingContext2D, bands: Float32Array, width: number, height: number, gain: number): void {
  const span = width * SPAN;
  const left = (width - span) / 2;
  const y = height * BASELINE;
  const step = span / bands.length;
  const center = Math.floor(bands.length / 2);
  context.rect(left, y - 1, span, 2);
  for (let i = 0; i < bands.length; i++) {
    const offset = i - center;
    const band = offset < 0 ? -2 * offset - 1 : 2 * offset;
    const energy = Math.max(0, (bands[band]! - NOISE_FLOOR) / (1 - NOISE_FLOOR));
    const edge = Math.sin((Math.PI * (i + 0.5)) / bands.length) ** 0.8;
    const rise = gain * energy * edge * (0.7 + 0.3 * jitter(i, 1));
    const x = left + (i + 0.5 + (jitter(i, 2) - 0.5) * 0.6) * step;
    traceNeedle(context, x, y, step * (0.35 + 0.35 * jitter(i, 3)), rise, rise * (0.35 + 0.4 * jitter(i, 4)));
  }
}

/** Draws one frame; states without live levels get a dimmer line and no glow. */
export function drawWaveform(context: CanvasRenderingContext2D, bands: Float32Array, state: ListenerState, reducedMotion: boolean): void {
  const scale = context.getTransform().a;
  const width = context.canvas.width / scale;
  const height = context.canvas.height / scale;
  context.clearRect(0, 0, width, height);
  context.beginPath();
  traceRegions(context, bands, width, height, height * MAX_RISE * (reducedMotion ? REDUCED_SCALE : 1));
  const active = LIVE[state];
  context.globalAlpha = active ? 1 : 0.45;
  context.shadowColor = GLOW;
  context.shadowBlur = active ? 12 : 0;
  context.fillStyle = WAVE;
  context.fill();
}

function fitToDisplay(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

/**
 * Animates `canvas` from real capture levels until the returned cleanup runs.
 * Drawing stops while the page is hidden and slows under reduced motion; capture itself is never touched.
 */
export function startWaveform(canvas: HTMLCanvasElement, levels: LevelSource, listener: () => ListenerState): () => void {
  const context = canvas.getContext('2d');
  if (!context) return () => {};
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const target = new Float32Array(levels.bandCount);
  const display = new Float32Array(levels.bandCount);
  let frame = 0;
  let last = performance.now();

  const draw = (now: number): void => {
    frame = requestAnimationFrame(draw);
    if (reduced.matches && now - last < REDUCED_FRAME_MS) return;
    const state = listener();
    if (LIVE[state]) levels.read(target);
    else target.fill(0);
    followEnvelope(display, target, now - last);
    last = now;
    fitToDisplay(canvas, context);
    drawWaveform(context, display, state, reduced.matches);
  };
  const onVisibility = (): void => {
    cancelAnimationFrame(frame);
    if (document.visibilityState === 'hidden') return;
    last = performance.now();
    frame = requestAnimationFrame(draw);
  };

  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
