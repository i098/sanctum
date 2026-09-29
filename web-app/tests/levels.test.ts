import { describe, expect, it } from 'vitest';
import { createAnalyserLevels } from '../src/lib/capture/levels.ts';

interface FakeAnalyser {
  frequencyBinCount: number;
  context: BaseAudioContext;
  spectrum: Uint8Array;
  waveform: Float32Array;
  targets: ArrayBufferView[];
  getByteFrequencyData(array: Uint8Array<ArrayBuffer>): void;
  getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void;
}

function fakeAnalyser(binCount: number, sampleRate: number): FakeAnalyser {
  const fake: FakeAnalyser = {
    frequencyBinCount: binCount,
    context: { sampleRate } as BaseAudioContext,
    spectrum: new Uint8Array(binCount),
    waveform: new Float32Array(binCount * 2),
    targets: [],
    getByteFrequencyData(array) {
      fake.targets.push(array);
      array.set(fake.spectrum);
    },
    getFloatTimeDomainData(array) {
      fake.targets.push(array);
      array.set(fake.waveform);
    },
  };
  return fake;
}

describe('createAnalyserLevels', () => {
  it('places energy in a single FFT bin into the log-spaced band covering it', () => {
    // 48 kHz, fftSize 2048: bin 43 is ~1008 Hz; band 18 of 33 spans ~986-1134 Hz.
    const analyser = fakeAnalyser(1024, 48_000);
    analyser.spectrum[43] = 255;
    const levels = createAnalyserLevels(analyser, 33);
    const bands = new Float32Array(33);
    levels.read(bands);
    expect(levels.bandCount).toBe(33);
    expect(bands[18]).toBeGreaterThan(0);
    expect(Array.from(bands).filter((value, band) => band !== 18 && value !== 0)).toEqual([]);
  });

  it('gives every band at least one bin even when bins are coarse', () => {
    const analyser = fakeAnalyser(8, 16_000);
    analyser.spectrum.fill(255);
    const bands = new Float32Array(12);
    createAnalyserLevels(analyser, 12).read(bands);
    expect(Array.from(bands)).toEqual(new Array(12).fill(1));
  });

  it('reads silence as zero level and zero bands', () => {
    const bands = new Float32Array(8).fill(0.5);
    const level = createAnalyserLevels(fakeAnalyser(1024, 48_000), 8).read(bands);
    expect(level).toBe(0);
    expect(Array.from(bands)).toEqual(new Array(8).fill(0));
  });

  it('reads a full-scale square wave as level ~1', () => {
    const analyser = fakeAnalyser(1024, 48_000);
    analyser.waveform.forEach((_, i) => (analyser.waveform[i] = Math.floor(i / 16) % 2 === 0 ? 1 : -1));
    expect(createAnalyserLevels(analyser, 4).read(new Float32Array(4))).toBeCloseTo(1, 6);
  });

  it('rejects band counts that are not positive integers', () => {
    const analyser = fakeAnalyser(1024, 48_000);
    for (const bandCount of [0, -1, 1.5, Number.NaN]) {
      expect(() => createAnalyserLevels(analyser, bandCount)).toThrow(RangeError);
    }
  });

  it('reuses its analyser buffers and writes into the caller-provided bands', () => {
    const analyser = fakeAnalyser(1024, 48_000);
    const levels = createAnalyserLevels(analyser, 33);
    const bands = new Float32Array(33);
    analyser.spectrum[43] = 255;
    levels.read(bands);
    const first = bands[18];
    analyser.spectrum[43] = 51;
    levels.read(bands);
    expect(bands[18]).toBeLessThan(first ?? 0);
    expect(bands[18]).toBeGreaterThan(0);
    const [spectrumA, waveformA, spectrumB, waveformB] = analyser.targets;
    expect(analyser.targets).toHaveLength(4);
    expect(spectrumB).toBe(spectrumA);
    expect(waveformB).toBe(waveformA);
  });
});
