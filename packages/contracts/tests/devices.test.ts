import { readFileSync } from 'node:fs';
import { Schema } from 'effect';
import { expect, it } from 'vitest';
import { DeviceCapabilities, DeviceState, StartMessage, decodePcmFrame } from '../src/index.ts';

interface Pattern {
  readonly color: string;
  readonly recording: boolean;
  readonly segments_ms?: readonly number[];
  readonly pulse_ms?: readonly [number, number];
  readonly digit_gap_ms?: number;
  readonly repeat_gap_ms?: number;
  readonly zero_blinks?: number;
}

const fixture: {
  start: unknown;
  frames: readonly {
    hex: string;
    track: number;
    sequence: number;
    sample_start: number;
    sample_count: number;
    sample_cycle: readonly number[];
  }[];
  pairing_codes: readonly string[];
  patterns: Record<DeviceState, Pattern>;
} = JSON.parse(readFileSync(new URL('../fixtures/device-wire.json', import.meta.url), 'utf8'));

it('decodes the golden 20 ms PCM frames and their device start', () => {
  const start = Schema.decodeUnknownSync(StartMessage)(fixture.start);
  expect(start.clock.sample_rate).toBe(16_000);
  expect(start.capabilities).toEqual({ mic: true, screen: false, light: 'mono', speaker: false });
  for (const { hex, sample_cycle, ...header } of fixture.frames) {
    const frame = decodePcmFrame(Buffer.from(hex, 'hex'));
    expect(frame).toEqual({ frame: { ...header, samples: Int16Array.from({ length: 320 }, (_, i) => sample_cycle[i % sample_cycle.length]!) } });
    expect(header.track).toBe(start.track);
  }
});

it('requires a microphone and at least one visible indicator on device starts', () => {
  const device = { mic: true, screen: false, light: 'mono', speaker: false };
  const valid = Schema.is(DeviceCapabilities);
  expect(valid(device)).toBe(true);
  expect(valid({ ...device, screen: true, light: 'none' })).toBe(true);
  expect(valid({ ...device, mic: false })).toBe(false);
  const start = Schema.decodeUnknownSync(StartMessage)(fixture.start);
  const { capabilities, ...browser } = start;
  expect(Schema.decodeUnknownSync(StartMessage)(browser).capabilities).toBeUndefined();
  expect(() => Schema.decodeUnknownSync(StartMessage)({ ...start, capabilities: { ...capabilities, light: 'none' } })).toThrow();
});

function segments(pattern: Pattern, code: string): readonly number[] {
  if (pattern.segments_ms) return pattern.segments_ms;
  const durations: number[] = [];
  const digits = code.replace('-', '');
  const [on, off] = pattern.pulse_ms!;
  for (const [index, digit] of [...digits].entries()) {
    const count = Number(digit) || pattern.zero_blinks!;
    for (let blink = 0; blink < count; blink++) durations.push(on, off);
    durations[durations.length - 1] = off + (index === digits.length - 1 ? pattern.repeat_gap_ms! : pattern.digit_gap_ms!);
  }
  return durations;
}

function measurePattern(pattern: Pattern, code: string) {
  const cycle = Uint8Array.from(segments(pattern, code).flatMap((ms, i) => Array<number>(ms).fill(1 - i % 2)));
  const window = new Uint8Array(1_000);
  let total = 0;
  let run = 0;
  let longestRun = 0;
  let leastLit = 1_000;
  for (let ms = 0; ms < 60_000; ms++) {
    const on = cycle[ms % cycle.length]!;
    const slot = ms % window.length;
    total += on - window[slot]!;
    window[slot] = on;
    if (ms >= window.length - 1) leastLit = Math.min(leastLit, total);
    run = on === Number(!pattern.recording) ? run + 1 : 0;
    longestRun = Math.max(longestRun, run);
  }
  return { longestRun, leastLit };
}

it('keeps recording visible in every 1 s window and never implies recording while idle', () => {
  for (const state of DeviceState.literals) {
    const recording = state === 'listening' || state === 'reconnecting' || state === 'degraded';
    const pattern = fixture.patterns[state];
    expect(pattern.recording).toBe(recording);
    for (const code of state === 'unpaired' ? fixture.pairing_codes : ['']) {
      const { longestRun, leastLit } = measurePattern(pattern, code);
      expect(longestRun, state).toBeLessThanOrEqual(recording ? 150 : 300);
      if (recording) expect(leastLit, state).toBeGreaterThanOrEqual(800);
    }
  }
});
