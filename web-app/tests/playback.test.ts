import { describe, expect, it } from 'vitest';
import { createPlayback } from '../src/lib/capture/playback.ts';

/** Records every source started and stopped; no real audio device. */
function fakeContext() {
  const started: Array<{ at: number; samples: ArrayLike<number>; stopped: boolean }> = [];
  const context = {
    currentTime: 10,
    destination: {} as AudioDestinationNode,
    createBuffer: (_channels: number, length: number, rate: number) => {
      const data = new Float32Array(length);
      return { duration: length / rate, copyToChannel: (samples: Float32Array) => data.set(samples), data } as unknown as AudioBuffer;
    },
    createBufferSource: () => {
      const record: (typeof started)[number] = { at: -1, samples: [], stopped: false };
      const source = {
        buffer: null as (AudioBuffer & { data: Float32Array }) | null,
        onended: null as (() => void) | null,
        connect: () => undefined,
        start: (at: number) => {
          record.at = at;
          record.samples = source.buffer!.data;
          started.push(record);
        },
        stop: () => {
          record.stopped = true;
        },
      };
      return source as unknown as AudioBufferSourceNode;
    },
  };
  return { context, started };
}

/** 100 ms at 24 kHz of a constant PCM16 value. */
const chunk = (generation: number, sequence: number, value = 16_384) => {
  const pcm = new DataView(new ArrayBuffer(4_800));
  for (let i = 0; i < 2_400; i++) pcm.setInt16(i * 2, value, true);
  const audio = btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)));
  return { _tag: 'speech_chunk', request_id: `r${generation}`, generation, sequence, sample_rate: 24_000, audio } as const;
};

describe('requested speech playback', () => {
  it('plays nothing without a speech chunk', () => {
    const { context, started } = fakeContext();
    const playback = createPlayback(context);
    playback.handle({ _tag: 'speech_cancel', generation: 5, reason: 'pause' });
    playback.stop();
    expect(started).toEqual([]);
    expect(playback.playing).toBe(false);
  });

  it('queues chunks of one generation back to back with decoded PCM16', () => {
    const { context, started } = fakeContext();
    const playback = createPlayback(context);
    playback.handle(chunk(7, 0));
    playback.handle(chunk(7, 1, -32_768));
    expect(started.map(source => source.at)).toEqual([10, expect.closeTo(10.1, 6)]);
    expect(started[0]!.samples[0]).toBe(0.5);
    expect(started[1]!.samples[0]).toBe(-1);
    expect(playback.playing).toBe(true);
  });

  it('stops on cancel and rejects late chunks of the cancelled generation', () => {
    const { context, started } = fakeContext();
    const playback = createPlayback(context);
    playback.handle(chunk(7, 0));
    playback.handle({ _tag: 'speech_cancel', generation: 7, reason: 'barge_in' });
    expect(started[0]!.stopped).toBe(true);
    playback.handle(chunk(7, 1));
    expect(started).toHaveLength(1);
    expect(playback.playing).toBe(false);
  });

  it('lets a newer generation replace an older one and drops stale audio', () => {
    const { context, started } = fakeContext();
    const playback = createPlayback(context);
    playback.handle(chunk(7, 0));
    playback.handle(chunk(9, 0));
    expect(started[0]!.stopped).toBe(true);
    playback.handle(chunk(7, 1));
    playback.handle(chunk(8, 0));
    expect(started).toHaveLength(2);
    expect(started[1]!.at).toBe(10);
  });

  it('does not resume the old reply after a disconnect, but plays a new request', () => {
    const { context, started } = fakeContext();
    const playback = createPlayback(context);
    playback.handle(chunk(7, 0));
    playback.stop();
    playback.handle(chunk(7, 1));
    expect(started).toHaveLength(1);
    expect(started[0]!.stopped).toBe(true);
    playback.handle(chunk(12, 0));
    expect(started).toHaveLength(2);
  });
});
