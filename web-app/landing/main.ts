/**
 * Landing page: the listening view's own waveform (src/pages/listen/waveform.ts) drawn from a
 * simulated conversation, so the page shows the product without asking for the microphone, and
 * the listening view's clock. Reduced motion keeps one still frame.
 */
import type { LevelSource } from '../src/lib/capture/view.ts';
import { startWaveform } from '../src/pages/listen/waveform.ts';

/** One band per waveform slot. */
const BANDS = 33;

/** Phrases of short syllables with pauses between them; each syllable lights a few random bands. */
function simulatedVoice(): LevelSource {
  const shape = new Float32Array(BANDS);
  let nextPhrase = 0;
  let phraseEnd = 0;
  let loudness = 0;
  let syllableEnd = 0;
  let syllableLength = 1;
  /** Starts a phrase after each pause, and the next syllable while the phrase lasts. */
  const advance = (now: number) => {
    if (now >= nextPhrase) {
      loudness = 0.45 + Math.random() * 0.4;
      phraseEnd = now + 1200 + Math.random() * 2600;
      nextPhrase = phraseEnd + 400 + Math.random() * 1600;
    }
    if (now < phraseEnd && now >= syllableEnd) {
      syllableLength = 110 + Math.random() * 170;
      syllableEnd = now + syllableLength;
      shape.forEach((_, i) => (shape[i] = Math.random() < 0.3 ? loudness * (0.4 + 0.6 * Math.random()) : 0.06 * Math.random()));
    }
  };
  return {
    bandCount: BANDS,
    read(bands) {
      const now = performance.now();
      advance(now);
      // Each syllable rises and falls once; a finished one rests at sin(π), about 0, until the next.
      const envelope = Math.sin(Math.PI * Math.min(1, 1 - (syllableEnd - now) / syllableLength));
      for (let i = 0; i < BANDS; i++) bands[i] = shape[i]! * envelope;
      return loudness * envelope;
    },
  };
}

const canvas = document.querySelector<HTMLCanvasElement>('.wave');
if (canvas && matchMedia('(prefers-reduced-motion: reduce)').matches) {
  // One still frame of the resting line: the waveform sizes the canvas on the first frame it draws,
  // and drawing stops right after it. A resize draws it again at the new size.
  const still = () => {
    canvas.width = 0;
    const stop = startWaveform(canvas, simulatedVoice(), () => 'stopped');
    const drawn = () => (canvas.width > 0 ? stop() : requestAnimationFrame(drawn));
    requestAnimationFrame(drawn);
  };
  still();
  addEventListener('resize', still);
} else if (canvas) {
  startWaveform(canvas, simulatedVoice(), () => 'listening');
}

const clock = document.querySelector<HTMLTimeElement>('.clock');
const tick = () => {
  if (!clock) return;
  const now = new Date();
  clock.dateTime = now.toISOString();
  clock.children[0]!.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  clock.children[1]!.textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};
tick();
setInterval(tick, 15_000);
