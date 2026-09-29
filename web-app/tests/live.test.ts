import { describe, expect, it } from 'vitest';
import { openLiveStream } from '../src/lib/capture/live.ts';

/** Minimal WebSocket double: the test drives open/message and reads what was sent. */
class FakeSocket {
  static last: FakeSocket;
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  closed = false;
  binaryType = '';
  bufferedAmount = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

const start = {
  _tag: 'start',
  protocol_version: 1,
  listener_id: '0b8f5c1e-3a52-4c1b-9d0e-5f7a2b6c8d90',
  epoch_id: '6c1d4e2f-8a3b-4c5d-9e6f-7a8b9c0d1e2f',
  track: 0,
  lease_generation: 1,
  clock: { sample_rate: 48_000, channels: 1, encoding: 'pcm_s16le', sample_start: 0, captured_at: '2026-09-29T09:00:00Z', timezone: 'UTC' },
} as const;

describe('live stream', () => {
  it('hands requested speech to playback and nothing else', () => {
    const speech: unknown[] = [];
    openLiveStream({ url: 'ws://test', start: start as never, onStatus: () => {}, onSpeech: message => speech.push(message), WebSocket: FakeSocket as never });
    const socket = FakeSocket.last;
    const chunk = { _tag: 'speech_chunk', request_id: 'r1', generation: 1, sequence: 0, sample_rate: 24_000, audio: 'AAA=' };
    const cancel = { _tag: 'speech_cancel', generation: 1, reason: 'barge_in' };
    socket.onmessage!({ data: JSON.stringify({ _tag: 'ack', sequence: 0, sample_end: 960 }) });
    socket.onmessage!({ data: JSON.stringify(chunk) });
    socket.onmessage!({ data: JSON.stringify(cancel) });
    expect(speech).toEqual([chunk, cancel]);
  });

  it('sends a clean stop, but drops the socket silently when the stop is an interruption', () => {
    const open = () => {
      const stream = openLiveStream({ url: 'ws://test', start: start as never, onStatus: () => {}, WebSocket: FakeSocket as never });
      return { stream, socket: FakeSocket.last };
    };
    const paused = open();
    paused.stream.stop('pause');
    expect(paused.socket.sent).toEqual([JSON.stringify({ _tag: 'stop', reason: 'pause' })]);
    const interrupted = open();
    interrupted.stream.stop(null);
    expect(interrupted.socket.sent).toEqual([]);
    expect(interrupted.socket.closed).toBe(true);
  });
});
