import { createClient } from '@sanctum/sdk';
import { describe, expect, it } from 'vitest';
import { loadReview, playbackOffset, type ReviewState, settle } from '../src/pages/listen/review-data.ts';

const MEETING = '5f0c6f7e-8d1b-4c2a-9e3f-1a2b3c4d5e6f';

const client = (status: number, body: unknown) =>
  createClient({ baseUrl: 'https://sanctum.test', fetch: async () => Response.json(body, { status }), maxAttempts: 1 });

describe('settle', () => {
  it('keeps a successful SDK result as an ok frame', async () => {
    const notes = { meeting_id: MEETING, revision: 2, boundary_revision: 1, title: 'Pilot review', summary: 'Kept the pilot small.', sections: [], model: 'm', generated_at: '2026-09-29T09:00:00Z' };
    expect(await settle(client(200, notes).meetings.getNotes({ meeting_id: MEETING }))).toEqual({ status: 'ok', data: notes });
  });

  it('reports the API error envelope truthfully instead of blanking the frame', async () => {
    const failed = client(503, { _tag: 'Unavailable', code: 'unavailable', message: 'Notes are not ready yet', retryable: true });
    expect(await settle(failed.meetings.getNotes({ meeting_id: MEETING }))).toEqual({ status: 'error', code: 'unavailable', message: 'Notes are not ready yet' });
  });

  it('reports network failures as network errors', async () => {
    const offline = createClient({ baseUrl: 'https://sanctum.test', fetch: async () => Promise.reject(new Error('offline')), maxAttempts: 1 });
    expect(await settle(offline.meetings.getNotes({ meeting_id: MEETING }))).toMatchObject({ status: 'error', code: 'network' });
  });
});

const EPOCH = '0b8f3c2e-6d4a-4f1b-9c7e-2a5d8e1f4b3c';
const RATE = 16_000;
const range = (from: number, to: number, epoch_id = EPOCH) => ({ epoch_id, track: 0, sample_start: from * RATE, sample_end: to * RATE });
const segment = (id: string, from: number, to: number) => ({
  id, source: range(from, to), text: `Said at ${from}s`, status: 'final', revision: 1, origin: 'live', provider: 'fixture', model: 'fixture',
  provider_connection_id: null, speaker_label: null, speaker_track_id: null, confidence: null, created_at: '2026-09-29T09:00:00Z',
});

/** Every state `loadReview` reports, in order. */
async function states(client: ReturnType<typeof createClient>) {
  const seen: ReviewState[] = [];
  await loadReview(client, new AbortController().signal, state => seen.push(state));
  return seen;
}

/** Same-origin v1 routes answered from `routes` by path; records every URL asked for. */
function fakeApi(routes: Record<string, (url: URL) => [number, unknown]>) {
  const asked: URL[] = [];
  const client = createClient({
    baseUrl: 'https://sanctum.test',
    maxAttempts: 1,
    fetch: async input => {
      const url = new URL(String(input));
      asked.push(url);
      const [status, body] = routes[url.pathname]?.(url) ?? [404, { code: 'not_found', message: 'Not found' }];
      return Response.json(body, { status });
    },
  });
  return { client, asked };
}

describe('loadReview', () => {
  it('reports no meetings instead of inventing one', async () => {
    const { client } = fakeApi({ '/api/v1/meetings': () => [200, { meetings: [], next_cursor: null }] });
    expect(await states(client)).toEqual([{ status: 'empty' }]);
  });

  it('reads every source of the latest meeting, pages to the end, and keeps a denied source as its own error', async () => {
    const meeting = { id: MEETING, title: 'Pilot review', state: 'closed', started_at: '2026-09-29T09:00:00Z' };
    const receipt = { action_id: 'a1', action_key: 'gmail-send-email', meeting_id: MEETING, state: 'succeeded', attempts: 1 };
    const event = { seq: 7, meeting_id: MEETING, item: null, change: 'meeting_boundary_changed', actor: 'p1', permission_revision: 1, created_at: '2026-09-29T09:10:00Z' };
    const { client, asked } = fakeApi({
      '/api/v1/meetings': () => [200, { meetings: [meeting], next_cursor: null }],
      [`/api/v1/meetings/${MEETING}/notes`]: () => [503, { code: 'unavailable', message: 'Notes are not ready yet', retryable: false }],
      [`/api/v1/meetings/${MEETING}/transcript`]: url =>
        url.searchParams.get('cursor') === null
          ? [200, { meeting_id: MEETING, boundary_revision: 1, segments: [segment('s1', 0, 5)], speakers: [], next_cursor: 'p2' }]
          : [200, { meeting_id: MEETING, boundary_revision: 1, segments: [segment('s2', 5, 9)], speakers: [], next_cursor: null }],
      [`/api/v1/meetings/${MEETING}/recording-access`]: () => [403, { code: 'forbidden', message: 'Requires recordings:read', retryable: false }],
      [`/api/v1/meetings/${MEETING}/context`]: () => [200, { meeting_id: MEETING, revision: 3, items: [] }],
      [`/api/v1/meetings/${MEETING}/actions`]: () => [200, { actions: [receipt], next_cursor: null }],
      '/api/v1/context/changes': url => [200, { events: url.searchParams.get('cursor') === null ? [event] : [], next_cursor: 'c7' }],
    });
    const seen = await states(client);
    const loading = { status: 'loading' };
    expect(seen[0]).toEqual({ status: 'ok', data: { meeting, notes: loading, transcript: loading, recording: loading, context: loading, actions: loading, changes: loading } });
    // One report per source as it settles; the last holds all six.
    expect(seen).toHaveLength(7);
    expect(seen.at(-1)).toMatchObject({
      status: 'ok',
      data: {
        meeting,
        notes: { status: 'error', code: 'unavailable', message: 'Notes are not ready yet' },
        transcript: { status: 'ok', data: [expect.objectContaining({ id: 's1' }), expect.objectContaining({ id: 's2' })] },
        recording: { status: 'error', code: 'forbidden', message: 'Requires recordings:read' },
        context: { status: 'ok', data: { revision: 3 } },
        actions: { status: 'ok', data: [receipt] },
        changes: { status: 'ok', data: [event] },
      },
    });
    const changes = asked.filter(url => url.pathname === '/api/v1/context/changes');
    expect(changes.map(url => url.searchParams.get('meeting_id'))).toEqual([MEETING, MEETING]);
    expect(changes[1]!.searchParams.get('cursor')).toBe('c7');
  });
});

describe('playbackOffset', () => {
  // The file holds source seconds [0, 30) then [40, 55): [30, 40) was never saved.
  const recording = {
    meeting_id: MEETING, boundary_revision: 1, url: 'https://objects.test/r1.wav', expires_at: '2026-09-29T09:05:00Z',
    gaps: [range(30, 40)], pieces: [range(0, 30), range(40, 55)], sample_rate: RATE as 16_000,
  };

  it('maps a source sample to its position in the file, skipping unsaved audio', () => {
    expect(playbackOffset(recording, range(10, 12))).toBe(10);
    expect(playbackOffset(recording, range(45, 50))).toBe(35);
  });

  it('starts a segment that begins in a gap at its first saved sample', () => {
    expect(playbackOffset(recording, range(38, 42))).toBe(30);
  });

  it('has no position for audio that was never saved or belongs to another epoch', () => {
    expect(playbackOffset(recording, range(32, 38))).toBeNull();
    expect(playbackOffset(recording, range(10, 12, '1c9e4d3f-7e5b-4a2c-8d0f-3b6e9f2a5c4d'))).toBeNull();
  });
});
