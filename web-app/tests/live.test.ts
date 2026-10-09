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

  it('tells the agent-work feed to clear when the stream is stopped on purpose', () => {
    const updates: unknown[] = [];
    const stream = openLiveStream({ url: 'ws://test', start: start as never, onStatus: () => {}, onActions: message => updates.push(message), WebSocket: FakeSocket as never });
    const socket = FakeSocket.last;
    const meeting = '5f0c6f7e-8d1b-4c2a-9e3f-1a2b3c4d5e6f';
    socket.onmessage!({ data: JSON.stringify({ _tag: 'action_update', meeting_id: meeting, actions: [] }) });
    socket.onclose!();
    expect(updates).toEqual([{ _tag: 'action_update', meeting_id: meeting, actions: [] }]);
    stream.stop('pause');
    expect(updates.at(-1)).toEqual({ _tag: 'action_update', meeting_id: null, actions: [] });
  });

  it('clears the agent-work feed when the server rejects the stream for good', () => {
    const updates: unknown[] = [];
    openLiveStream({ url: 'ws://test', start: start as never, onStatus: () => {}, onActions: message => updates.push(message), WebSocket: FakeSocket as never });
    FakeSocket.last.onmessage!({ data: JSON.stringify({ _tag: 'rejected', reason: 'stale_generation', message: 'taken over' }) });
    expect(updates).toEqual([{ _tag: 'action_update', meeting_id: null, actions: [] }]);
  });

  it('ignores server messages that arrive after the stream is stopped', () => {
    const updates: unknown[] = [];
    const stream = openLiveStream({ url: 'ws://test', start: start as never, onStatus: () => {}, onActions: message => updates.push(message), WebSocket: FakeSocket as never });
    const socket = FakeSocket.last;
    stream.stop('pause');
    socket.onmessage!({ data: JSON.stringify({ _tag: 'action_update', meeting_id: '5f0c6f7e-8d1b-4c2a-9e3f-1a2b3c4d5e6f', actions: [] }) });
    expect(updates).toEqual([{ _tag: 'action_update', meeting_id: null, actions: [] }]);
  });

  it('keeps the server reason for degraded live transcription, also through socket backpressure', () => {
    const statuses: unknown[][] = [];
    const stream = openLiveStream({ url: 'ws://test', start: start as never, onStatus: (...update) => void statuses.push(update), WebSocket: FakeSocket as never });
    const socket = FakeSocket.last;
    socket.onmessage!({ data: JSON.stringify({ _tag: 'accepted', epoch_id: start.epoch_id, resume_from_sample: 0, max_frame_bytes: 65_536 }) });
    socket.onmessage!({ data: JSON.stringify({ _tag: 'degraded', reason: 'provider_unavailable', from_sample: 17_640 }) });
    socket.bufferedAmount = 1_000_000;
    stream.send(0, new Int16Array(960));
    expect(statuses).toEqual([['connecting'], ['live'], ['degraded', 'provider_unavailable'], ['degraded', 'provider_unavailable']]);
  });

  it('returns to live when the server reports recovered live transcription, and stays degraded without it', () => {
    const statuses: unknown[][] = [];
    openLiveStream({ url: 'ws://test', start: start as never, onStatus: (...update) => void statuses.push(update), WebSocket: FakeSocket as never });
    const socket = FakeSocket.last;
    const server = (message: object) => socket.onmessage!({ data: JSON.stringify(message) });
    server({ _tag: 'accepted', epoch_id: start.epoch_id, resume_from_sample: 0, max_frame_bytes: 65_536 });
    server({ _tag: 'degraded', reason: 'asr_backlog', from_sample: 6_079_185 });
    expect(statuses.at(-1)).toEqual(['degraded', 'asr_backlog']);
    server({ _tag: 'recovered' });
    expect(statuses).toEqual([['connecting'], ['live'], ['degraded', 'asr_backlog'], ['live']]);
  });
});
