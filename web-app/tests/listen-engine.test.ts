import type { SpeechCancelMessage, SpeechChunkMessage } from '@sanctum/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureDeps } from '../src/lib/capture/controller.ts';
import { getCaptureEngine } from '../src/pages/listen/engine.ts';
import { createCaptureStore, type CaptureSnapshot, type ListenerState } from '../src/lib/capture/view.ts';

/** The page engine wired to a stand-in controller whose listener state the test drives. */
const fake = vi.hoisted(() => ({
  store: null as unknown as { update(patch: Partial<CaptureSnapshot>): void },
  speak: null as unknown as NonNullable<CaptureDeps['onSpeech']>,
  sources: [] as Array<{ stopped: boolean }>,
}));

vi.mock('../src/lib/capture/controller.ts', () => ({
  createCaptureController: (deps: CaptureDeps) => {
    const store = createCaptureStore();
    fake.store = store;
    fake.speak = deps.onSpeech!;
    return { ...store.view };
  },
}));

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, copyToChannel: () => undefined };
  }
  createBufferSource() {
    const record = { stopped: false };
    fake.sources.push(record);
    return { buffer: null, onended: null, connect: () => undefined, start: () => undefined, stop: () => void (record.stopped = true) };
  }
}
vi.stubGlobal('AudioContext', FakeAudioContext);

getCaptureEngine();

const chunk = (generation: number, sequence: number): SpeechChunkMessage => ({
  _tag: 'speech_chunk',
  request_id: `r${generation}`,
  generation,
  sequence,
  sample_rate: 24_000,
  audio: btoa(String.fromCharCode(...new Uint8Array(480))),
});
const cancel = (generation: number): SpeechCancelMessage => ({ _tag: 'speech_cancel', generation, reason: 'barge_in' });
const state = (listener: ListenerState) => fake.store.update({ listener });
const stopped = () => fake.sources.map((source) => source.stopped);
let generation = 0;

beforeEach(() => {
  state('listening');
  fake.sources.length = 0;
  generation++;
});

describe('page engine playback', () => {
  it('keeps playing a requested reply through a degraded transition', () => {
    fake.speak(chunk(generation, 0));
    state('degraded');
    fake.speak(chunk(generation, 1));
    state('listening');
    expect(stopped()).toEqual([false, false]);
  });

  it.each(['paused', 'reconnecting', 'stopped'] as const)('cuts the reply on %s, even after a degraded transition', (listener) => {
    fake.speak(chunk(generation, 0));
    state('degraded');
    state(listener);
    fake.speak(chunk(generation, 1)); // late chunk of the cut reply
    expect(stopped()).toEqual([true]);
  });

  it('still cuts a degraded reply on barge-in and on a newer generation', () => {
    state('degraded');
    fake.speak(chunk(generation, 0));
    fake.speak(cancel(generation));
    expect(stopped()).toEqual([true]);

    generation++;
    fake.speak(chunk(generation, 0));
    fake.speak(chunk(generation + 1, 0));
    expect(stopped()).toEqual([true, true, false]);
    generation++;
  });
});
