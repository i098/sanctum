/**
 * Fullscreen waveform: the earlier Sanctum kiosk's audio-reactive ink seismograph
 * (42nights/sanctum web-app/src/pages/kiosk/engine.ts), ported one-to-one on explicit request.
 * A thin baseline carries sharp needle spikes with soft ink-blot bases. Each of 33 slots owns a
 * jittered x, a needle width, an asymmetric underside and one shuffled spectrum band, fixed per
 * mount, so live voice lands as scattered bursts instead of a left-to-right equalizer.
 * Plain typed-array code driven by requestAnimationFrame; samples never enter React state.
 */
import type { LevelSource, ListenerState } from '../../lib/capture/view.ts';

/** Kiosk orb state: amplitude, breathing speed, glow strength and the accent the ink and glow take. */
interface Look {
  amp: number;
  speed: number;
  glow: number;
  r: number;
  g: number;
  b: number;
}

/** The kiosk's `idle`, `connecting` and `listening` states. */
const IDLE: Look = { amp: 6, speed: 0.4, glow: 0.42, r: 61, g: 125, b: 255 };
const CONNECTING: Look = { amp: 9, speed: 1.8, glow: 0.55, r: 61, g: 125, b: 255 };
const LISTENING: Look = { amp: 14, speed: 0.95, glow: 0.8, r: 34, g: 211, b: 197 };

/** Only `listening` couples to the microphone; every other state breathes without reading levels. */
const LOOK: Record<ListenerState, Look> = {
  stopped: IDLE,
  paused: IDLE,
  starting: CONNECTING,
  reconnecting: CONNECTING,
  listening: LISTENING,
  degraded: LISTENING,
};

/**
 * The kiosk's stage in CSS px: a 760 px line (at most 92vw) with needles up to 118 px tall per unit.
 * Its canvas was 300 px tall and cut loud needles and their glow flat; here the canvas covers the
 * viewport so they keep their full shape. Narrower lines scale every size, as the kiosk's canvas did.
 */
const WIDTH = 760;
const RISE = 118;
/** Baseline height as a fraction of the viewport, from the 1280 × 720 reference (y = 316). */
const BASELINE = 316 / 720;
const SLOTS = 33;
/** State changes tween over 0.9 s with GSAP's power3.out (quartic ease-out). */
const TWEEN_MS = 900;
const REDUCED_FRAME_MS = 250;
const REDUCED_SCALE = 0.45;
/** Noise floor: rises toward a band's level with this time constant and falls to a quieter level at once. */
const FLOOR_RISE_S = 2;
/** Band level above the floor that still draws nothing: the frame-to-frame flutter of steady noise. */
const FLOOR_MARGIN = 0.08;

interface Slot {
  /** Centre as a fraction of the line. */
  readonly x: number;
  /** Needle half-width as a fraction of the line. */
  readonly w: number;
  /** Underside ratio: never a pure mirror. */
  readonly asym: number;
  /** Idle-breathing phase. */
  readonly ph: number;
  /** A few slots carry the resting line (tall breathers); most stay quiet. */
  readonly pop: number;
  /** Edges stay quiet. */
  readonly env: number;
  readonly band: number;
}

function createSlots(): Slot[] {
  const bands = Array.from({ length: SLOTS }, (_, i) => i);
  for (let i = SLOTS - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bands[i], bands[j]] = [bands[j]!, bands[i]!];
  }
  return bands.map((band, k) => {
    const x = (k + 0.5) / SLOTS + ((Math.random() - 0.5) * 0.6) / SLOTS;
    return {
      x,
      w: 0.011 + Math.random() * 0.02,
      asym: 0.45 + Math.random() * 0.55,
      ph: Math.random() * Math.PI * 2,
      pop: Math.random() < 0.16 ? 2.8 : Math.random() < 0.35 ? 1.2 : 0.45,
      env: Math.sin(Math.PI * x) ** 0.8,
      band,
    };
  });
}

/** Sharp ink needle (steep power falloff) plus the wide, shallow ink bleed at its base; 0 outside both. */
function ink(distance: number, halfWidth: number): number {
  const d = Math.min(1, distance / halfWidth);
  const db = Math.min(1, distance / (halfWidth * 3.4));
  return (1 - d) ** 3.4 + 0.16 * (1 - db) ** 1.6;
}

/** Moves `look` along the tween from `from` to `to`; `progress` is elapsed / duration. */
function tween(look: Look, from: Look, to: Look, progress: number): void {
  const eased = 1 - (1 - Math.min(1, progress)) ** 4;
  for (const key of ['amp', 'speed', 'glow', 'r', 'g', 'b'] as const) look[key] = from[key] + (to[key] - from[key]) * eased;
}

/** Spectral RMS of the 0..1 bands: the kiosk's overall level. */
function spectrumLevel(bands: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < bands.length; i++) sum += bands[i]! * bands[i]!;
  return Math.sqrt(sum / bands.length);
}

/**
 * Steady room noise draws a calm line. Each band keeps a floor that drops to the band's quietest
 * level at once and rises over FLOOR_RISE_S, so hum, fans and hiss become the floor within a few
 * seconds while speech, which comes and goes, stays above it. Only the level above floor + margin,
 * rescaled to 0..1, reaches the needles.
 */
export function createNoiseFloor(bandCount: number): (bands: Float32Array, seconds: number) => void {
  const floor = new Float32Array(bandCount);
  return (bands, seconds) => {
    const rise = 1 - Math.exp(-seconds / FLOOR_RISE_S);
    for (let i = 0; i < bandCount; i++) {
      const value = bands[i]!;
      const gate = (floor[i] = Math.min(value, floor[i]! + (value - floor[i]!) * rise)) + FLOOR_MARGIN;
      bands[i] = value > gate ? (value - gate) / (1 - gate) : 0;
    }
  };
}

/** Per-slot targets: idle breathing plus the slot's spectrum band; fast attack, slow decay. */
function followSlots(slots: ReadonlyArray<Slot>, current: Float32Array, bands: Float32Array, look: Look, t: number, level: number): void {
  const ampScale = (look.amp / 14) * (0.55 + level * 1.35);
  slots.forEach((slot, k) => {
    const wobble = slot.pop * (0.045 + 0.04 * Math.sin(t * look.speed * 1.7 + slot.ph) + 0.028 * Math.sin(t * look.speed * 0.6 + slot.ph * 2.3));
    const goal = Math.min(1.2, Math.max(0.015, wobble) + (bands[slot.band] ?? 0) ** 2 * 1.3) * slot.env * ampScale;
    const value = current[k]!;
    current[k] = value + (goal - value) * (goal > value ? 0.5 : 0.12);
  });
}

/** Contour heights above and below the baseline at every sample; the underside follows each slot's asymmetry. */
function traceContours(slots: ReadonlyArray<Slot>, current: Float32Array, top: Float32Array, bottom: Float32Array): void {
  for (let i = 0; i < top.length; i++) {
    const u = i / (top.length - 1);
    let above = 0;
    let below = 0;
    for (let k = 0; k < slots.length; k++) {
      const slot = slots[k]!;
      const h = current[k]! * ink(Math.abs(u - slot.x), slot.w);
      above += h;
      below += h * slot.asym;
    }
    top[i] = above;
    bottom[i] = below;
  }
}

/** Sizes the canvas to its box in device pixels (capped at 2×, like the kiosk); returns that ratio. */
function fitToDisplay(canvas: HTMLCanvasElement): number {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return ratio;
}

/** One closed ink shape around the baseline, glowing in the state colour; `amplitude` is 1 or the reduced-motion scale. */
function fillShape(context: CanvasRenderingContext2D, top: Float32Array, bottom: Float32Array, look: Look, level: number, amplitude: number): void {
  const ratio = fitToDisplay(context.canvas);
  const { width, height } = context.canvas;
  const line = Math.min(WIDTH * ratio, width * 0.92);
  const scale = line / WIDTH;
  const left = (width - line) / 2;
  const middle = height * BASELINE;
  const base = 1.1 * scale;
  const rise = RISE * scale * amplitude;
  const step = line / (top.length - 1);
  const mix = (white: number, accent: number): number => Math.round(white * 0.62 + accent * 0.38);
  context.clearRect(0, 0, width, height);
  context.shadowColor = `rgba(${look.r},${look.g},${look.b},${0.55 * look.glow * (1 + level)})`;
  context.shadowBlur = (14 + level * 26) * scale;
  context.fillStyle = `rgba(${mix(235, look.r)},${mix(240, look.g)},${mix(245, look.b)},0.92)`;
  context.beginPath();
  context.moveTo(left, middle - base);
  top.forEach((h, i) => context.lineTo(left + i * step, middle - base - h * rise));
  for (let i = bottom.length - 1; i >= 0; i--) context.lineTo(left + i * step, middle + base + bottom[i]! * rise);
  context.closePath();
  context.fill();
}

/**
 * Animates `canvas` from real capture levels until the returned cleanup runs.
 * Drawing stops while the page is hidden and slows under reduced motion; capture itself is never touched.
 */
export function startWaveform(canvas: HTMLCanvasElement, levels: LevelSource, listener: () => ListenerState): () => void {
  const context = canvas.getContext('2d');
  if (!context) return () => {};
  // Contour samples every 2 px of the 760 px line.
  const top = new Float32Array(WIDTH / 2 + 1);
  const bottom = new Float32Array(WIDTH / 2 + 1);
  const slots = createSlots();
  const current = new Float32Array(SLOTS);
  const bands = new Float32Array(levels.bandCount);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const calm = createNoiseFloor(levels.bandCount);
  const look: Look = { ...IDLE };
  let from: Look = { ...IDLE };
  let to = IDLE;
  let tweenStart = 0;
  let t = 0;
  let level = 0;
  let levelTarget = 0;
  let frame = 0;
  let last = 0;

  const retarget = (now: number): void => {
    const target = LOOK[listener()];
    if (target === to) return;
    from = { ...look };
    to = target;
    tweenStart = now;
  };
  /** Only the listening look reads the microphone; every other state hears silence. */
  const hear = (seconds: number): void => {
    if (to !== LISTENING) return void bands.fill(0);
    levels.read(bands);
    calm(bands, seconds);
    levelTarget = Math.max(levelTarget, Math.min(1, spectrumLevel(bands) * 1.6));
  };
  const draw = (now: number): void => {
    frame = requestAnimationFrame(draw);
    if (reduced.matches && now - last < REDUCED_FRAME_MS) return;
    // A frame after a hidden stretch counts as one reduced-motion frame.
    const seconds = Math.min(now - last, REDUCED_FRAME_MS) / 1000;
    last = now;
    retarget(now);
    tween(look, from, to, (now - tweenStart) / TWEEN_MS);
    hear(seconds);
    t += 0.016;
    level += (levelTarget - level) * 0.18;
    levelTarget *= 0.92;
    followSlots(slots, current, bands, look, t, level);
    traceContours(slots, current, top, bottom);
    fillShape(context, top, bottom, look, level, reduced.matches ? REDUCED_SCALE : 1);
  };
  const onVisibility = (): void => {
    cancelAnimationFrame(frame);
    if (document.visibilityState === 'hidden') return;
    last = 0;
    frame = requestAnimationFrame(draw);
  };

  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
