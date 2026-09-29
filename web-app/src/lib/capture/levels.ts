import type { LevelSource } from './view.ts';

type Analyser = Pick<AnalyserNode, 'frequencyBinCount' | 'getFloatTimeDomainData' | 'getByteFrequencyData' | 'context'>;

const LOW_HZ = 80;
const HIGH_HZ = 8000;

/** Per band [start, end) bin ranges, log-spaced LOW_HZ..HIGH_HZ; every band gets at least one bin. */
function bandBins(binCount: number, sampleRate: number, bandCount: number): Uint32Array {
  const binHz = sampleRate / (2 * binCount);
  const ranges = new Uint32Array(bandCount * 2);
  const binAt = (band: number) => Math.round((LOW_HZ * (HIGH_HZ / LOW_HZ) ** (band / bandCount)) / binHz);
  for (let band = 0; band < bandCount; band++) {
    const start = Math.min(binAt(band), binCount - 1);
    ranges[band * 2] = start;
    ranges[band * 2 + 1] = Math.min(Math.max(binAt(band + 1), start + 1), binCount);
  }
  return ranges;
}

function fillBands(spectrum: Uint8Array, ranges: Uint32Array, bands: Float32Array): void {
  for (let band = 0; band * 2 < ranges.length; band++) {
    const start = ranges[band * 2] ?? 0;
    const end = ranges[band * 2 + 1] ?? 0;
    let sum = 0;
    for (let bin = start; bin < end; bin++) sum += spectrum[bin] ?? 0;
    bands[band] = sum / ((end - start) * 255);
  }
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

export function createAnalyserLevels(analyser: Analyser, bandCount: number): LevelSource {
  if (!Number.isInteger(bandCount) || bandCount < 1) {
    throw new RangeError(`bandCount must be a positive integer, got ${bandCount}`);
  }
  const binCount = analyser.frequencyBinCount;
  const spectrum = new Uint8Array(binCount);
  const waveform = new Float32Array(binCount * 2);
  const ranges = bandBins(binCount, analyser.context.sampleRate, bandCount);
  return {
    bandCount,
    read(bands) {
      analyser.getByteFrequencyData(spectrum);
      fillBands(spectrum, ranges, bands);
      analyser.getFloatTimeDomainData(waveform);
      return rms(waveform);
    },
  };
}
