import { createClient } from '@sanctum/sdk';
import { describe, expect, it } from 'vitest';
import { settle } from '../src/pages/listen/review-data.ts';

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
