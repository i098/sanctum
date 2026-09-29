/** Deterministic synthetic audio for tests; never used as production input. */

export interface SyntheticPcmOptions {
  readonly sampleRate: number;
  readonly seconds: number;
  /** Tone frequency; 0 produces digital silence. */
  readonly toneHz: number;
  /** Peak amplitude as a fraction of full scale, 0..1. */
  readonly amplitude?: number;
}

/** Mono PCM16 sine tone; sample `i` is identical on every run and platform. */
export function syntheticPcm({ sampleRate, seconds, toneHz, amplitude = 0.5 }: SyntheticPcmOptions): Int16Array {
  const samples = new Int16Array(Math.round(sampleRate * seconds));
  const step = (2 * Math.PI * toneHz) / sampleRate;
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(step * i) * amplitude * 32_767);
  return samples;
}
