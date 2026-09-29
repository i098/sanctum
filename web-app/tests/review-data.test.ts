import { createClient } from '@sanctum/sdk';
import { describe, expect, it } from 'vitest';
import { loadReview } from '../src/pages/listen/review-data.ts';

const MEETING = '5f0c6f7e-8d1b-4c2a-9e3f-1a2b3c4d5e6f';
const item = (kind: string, state: string, text: string) => ({ id: text, revision: 1, meeting_id: MEETING, kind, text, state, sources: [] });

/** Routes each v1 path to a canned status and body, recording what the loader asked for. */
function server(routes: Record<string, { status: number; body: unknown }>) {
  const asked: string[] = [];
  const fetch: typeof globalThis.fetch = async input => {
    const url = new URL(String(input));
    asked.push(url.pathname + url.search);
    const route = routes[url.pathname] ?? { status: 404, body: { code: 'not_found', message: 'Not found', retryable: false } };
    return Response.json(route.body, { status: route.status });
  };
  return { asked, client: createClient({ baseUrl: 'https://sanctum.test', fetch, maxAttempts: 1 }) };
}

const context = {
  status: 200,
  body: {
    meeting_id: MEETING,
    revision: 4,
    items: [item('decision', 'committed', 'Ship B'), item('open_question', 'provisional', 'Budget?'), item('preference', 'committed', 'Mornings')],
    changes_cursor: 'c4',
    truncated: false,
  },
};

describe('loadReview', () => {
  it('fills all six frames from the v1 operations', async () => {
    const { client, asked } = server({
      [`/api/v1/meetings/${MEETING}/context`]: context,
      [`/api/v1/meetings/${MEETING}/transcript`]: { status: 200, body: { items: [{ id: 's1', text: 'Hello' }], next_cursor: null } },
      [`/api/v1/meetings/${MEETING}/recording-access`]: { status: 200, body: { url: 'https://objects.test/a.wav', gaps: [] } },
      '/api/v1/context/changes': { status: 200, body: { items: [{ seq: 4, change: 'item_added' }], next_cursor: 'c4' } },
    });
    const review = await loadReview(client, MEETING);
    expect(review.notes).toEqual({ status: 'ok', data: { decision: [context.body.items[0]], commitment: [], open_question: [context.body.items[1]] } });
    expect(review.memory).toEqual({ status: 'ok', data: [context.body.items[0], context.body.items[2]] });
    expect(review.context).toMatchObject({ status: 'ok', data: { revision: 4 } });
    expect(review.transcript).toMatchObject({ status: 'ok', data: { items: [{ text: 'Hello' }] } });
    expect(review.recording).toMatchObject({ status: 'ok', data: { url: 'https://objects.test/a.wav' } });
    expect(review.activity).toMatchObject({ status: 'ok', data: { items: [{ change: 'item_added' }] } });
    expect(asked).toContain(`/api/v1/context/changes?meeting_id=${MEETING}&limit=50`);
  });

  it('reports a failing frame truthfully without blanking the others', async () => {
    const { client } = server({
      [`/api/v1/meetings/${MEETING}/context`]: context,
      [`/api/v1/meetings/${MEETING}/recording-access`]: { status: 403, body: { code: 'forbidden', message: 'Requires recordings:read', retryable: false } },
    });
    const review = await loadReview(client, MEETING);
    expect(review.recording).toEqual({ status: 'error', code: 'forbidden', message: 'Requires recordings:read' });
    expect(review.transcript).toMatchObject({ status: 'error', code: 'not_found' });
    expect(review.context.status).toBe('ok');
  });

  it('marks notes, memory and context unavailable when the snapshot fails', async () => {
    const { client } = server({
      [`/api/v1/meetings/${MEETING}/context`]: { status: 503, body: { code: 'unavailable', message: 'Database unavailable', retryable: false } },
    });
    const review = await loadReview(client, MEETING);
    for (const frame of [review.notes, review.memory, review.context]) expect(frame).toEqual({ status: 'error', code: 'unavailable', message: 'Database unavailable' });
  });
});
