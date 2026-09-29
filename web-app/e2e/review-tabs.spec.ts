import { expect, type Page, test } from '@playwright/test';
import { openListening } from './listen-fake.ts';

/**
 * Review tabs over fixture v1 responses. Recording: 30 s saved, 10 s never saved, then 15 s
 * saved, so source second 45 plays at second 35 of the signed file.
 */
test.use({ locale: 'en-US', timezoneId: 'UTC' });

const MEETING = '5f0c6f7e-8d1b-4c2a-9e3f-1a2b3c4d5e6f';
const EPOCH = '0b8f3c2e-6d4a-4f1b-9c7e-2a5d8e1f4b3c';
const RATE = 8_000;
const [S1, S2, S3] = ['a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f'];
const DECISION = 'd4e5f6a7-b8c9-4d0e-9f1a-3b4c5d6e7f80';
const AUDIO = '/fixture-audio/r1.wav?sig=fixture';

const range = (from: number, to: number) => ({ epoch_id: EPOCH, track: 0, sample_start: from * RATE, sample_end: to * RATE });
const segment = (id: string, from: number, to: number, text: string, speaker_label: string | null) => ({
  id, source: range(from, to), text, status: 'final', revision: 1, origin: 'live', provider: 'fixture', model: 'fixture',
  provider_connection_id: null, speaker_label, speaker_track_id: null, confidence: null, created_at: '2026-09-29T09:00:00Z',
});
const item = (id: string, kind: string, text: string, state: string, source: { segment_id: string; start_ms: number }) => ({
  id, revision: 2, meeting_id: MEETING, kind, text, state, derivation: 'spoken', event_at: '2026-09-29T09:00:45Z', valid_from: null, valid_until: null,
  time: null, author: { type: 'system', id: 'extractor' }, sources: [{ ...source, end_ms: source.start_ms + 5_000 }], supersedes: null, created_at: '2026-09-29T09:01:00Z',
});
const receipt = (action_id: string, action_key: string, state: string, reconciliation: string) => ({
  action_id, action_key, meeting_id: MEETING, state, args_sha256: 'a'.repeat(64), grant: null, provider_receipt: null, attempts: 1, reconciliation, updated_at: '2026-09-29T09:20:00Z',
});

const FIXTURES: Record<string, unknown> = {
  '/api/v1/meetings': { meetings: [{ id: MEETING, title: 'Pilot review', state: 'closed', started_at: '2026-09-29T09:00:00Z', timezone: 'America/Los_Angeles' }], next_cursor: null },
  [`/api/v1/meetings/${MEETING}/notes`]: {
    meeting_id: MEETING, revision: 2, boundary_revision: 1, model: 'fixture', title: 'Pilot review', summary: 'The team kept the pilot small.', generated_at: '2026-09-29T09:30:00Z',
    sections: [{ heading: 'Next steps', points: [{ text: 'Dana sends the pilot plan.', sources: [{ segment_id: S1, start_ms: 0, end_ms: 5_000 }] }] }],
  },
  [`/api/v1/meetings/${MEETING}/transcript`]: {
    meeting_id: MEETING, boundary_revision: 1, speakers: [], next_cursor: null,
    segments: [
      segment(S1, 0, 5, 'I will send the pilot plan.', 'Dana'),
      segment(S3, 32, 38, 'Said while the laptop slept.', null),
      segment(S2, 45, 50, 'Keep pilot access to the test group.', 'Lee'),
    ],
  },
  [`/api/v1/meetings/${MEETING}/recording-access`]: {
    meeting_id: MEETING, boundary_revision: 1, url: AUDIO, expires_at: '2026-09-29T09:35:00Z', gaps: [range(30, 40)], pieces: [range(0, 30), range(40, 55)], sample_rate: RATE,
  },
  [`/api/v1/meetings/${MEETING}/context`]: {
    meeting_id: MEETING, revision: 5, as_of: '2026-09-29T09:30:00Z', timezone: 'America/Los_Angeles', source_watermark: null, changes_cursor: 'c4', truncated: false,
    items: [
      item(DECISION, 'decision', 'Keep pilot access limited to the test group.', 'committed', { segment_id: S2, start_ms: 45_000 }),
      item('e5f6a7b8-c9d0-4e1f-8a2b-4c5d6e7f8091', 'commitment', 'Dana sends the pilot plan.', 'provisional', { segment_id: S1, start_ms: 0 }),
    ],
  },
  [`/api/v1/meetings/${MEETING}/actions`]: {
    actions: [receipt('f6a7b8c9-d0e1-4f2a-9b3c-5d6e7f8091a2', 'gmail-send-email', 'succeeded', 'none'), receipt('a7b8c9d0-e1f2-4a3b-8c4d-6e7f8091a2b3', 'slack-send-message', 'unknown', 'pending')],
    next_cursor: null,
  },
};
const CHANGE = { seq: 4, meeting_id: MEETING, item: { id: DECISION, revision: 2 }, change: 'item_revised', actor: 'p1', permission_revision: 1, created_at: '2026-09-29T09:25:00Z' };

/** Mono PCM16 silence: a real file the browser decodes and seeks. */
function silentWav(seconds: number): Buffer {
  const bytes = seconds * RATE * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + bytes, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(bytes, 40);
  return wav;
}

type Answer = readonly [number, unknown] | (() => Promise<readonly [number, unknown]>);

/** Fixture v1 routes plus byte-range audio behind the signed URL; `overrides` replaces answers by path. */
async function reviewApi(page: Page, overrides: Record<string, Answer> = {}) {
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    const override = overrides[url.pathname];
    const changes = url.pathname === '/api/v1/context/changes' && { events: url.searchParams.get('cursor') === null ? [CHANGE] : [], next_cursor: 'c4' };
    const [status, json] = typeof override === 'function' ? await override() : (override ?? [200, changes || FIXTURES[url.pathname]]);
    return route.fulfill({ status, json });
  });
  const wav = silentWav(45);
  await page.route('**/fixture-audio/r1.wav*', route => {
    const [, from, to] = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] ?? '') ?? [];
    if (from === undefined) return route.fulfill({ body: wav, contentType: 'audio/wav', headers: { 'accept-ranges': 'bytes' } });
    const [start, end] = [Number(from), to ? Number(to) : wav.length - 1];
    return route.fulfill({ status: 206, body: wav.subarray(start, end + 1), contentType: 'audio/wav', headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${wav.length}` } });
  });
}

async function openReview(page: Page) {
  await openListening(page);
  await page.getByRole('button', { name: 'Review' }).click();
  return page.getByRole('dialog', { name: 'Review' });
}

const unavailable = (message: string) => [503, { _tag: 'Unavailable', code: 'unavailable', message, retryable: false }] as const;

test('each Review tab shows the latest meeting\'s real records', async ({ page }) => {
  await reviewApi(page);
  const review = await openReview(page);
  await expect(review).toContainText('Pilot review · closed · started 9/29/2026, 2:00:00 AM');
  await review.getByRole('tab', { name: 'Transcript' }).click();
  await expect(review.getByRole('tabpanel', { name: 'Transcript' }).getByRole('listitem')).toHaveText([
    'Dana I will send the pilot plan. Play',
    'Unattributed Said while the laptop slept. no saved audio',
    'Lee Keep pilot access to the test group. Play',
  ]);
  await review.getByRole('tab', { name: 'Recording' }).click();
  await expect(review.getByLabel('Meeting recording')).toHaveAttribute('src', AUDIO);
  await expect(review.getByRole('tabpanel', { name: 'Recording' })).toContainText('One part of this meeting has no saved audio; playback skips it.');
  await review.getByRole('tab', { name: 'Memory' }).click();
  await expect(review.getByRole('tabpanel', { name: 'Memory' }).getByRole('listitem')).toHaveText(['decision Keep pilot access limited to the test group. committed · spoken · revision 2 0:45']);
  await review.getByRole('tab', { name: 'Context' }).click();
  const context = review.getByRole('tabpanel', { name: 'Context' });
  await expect(context).toContainText('Context revision 5 as of 02:30 AM (America/Los_Angeles)');
  await expect(context.getByRole('listitem')).toHaveText([/^decision Keep pilot access .* committed/, /^commitment Dana sends the pilot plan\. provisional · spoken · revision 2 0:00$/]);
  await review.getByRole('tab', { name: 'Activity' }).click();
  const activity = review.getByRole('tabpanel', { name: 'Activity' });
  await expect(activity.getByRole('listitem')).toHaveText([
    'gmail-send-email succeeded 1 attempt · 09:20 AM',
    'slack-send-message unknown 1 attempt · awaiting reconciliation · 09:20 AM',
    'item revised Keep pilot access limited to the test group. (revision 2) 09:25 AM',
  ]);
});

test('a decision\'s source opens its transcript segment, whose Play seeks authorized audio there', async ({ page }) => {
  await reviewApi(page);
  const review = await openReview(page);
  await review.getByRole('tab', { name: 'Memory' }).click();
  await review.getByRole('button', { name: 'Show transcript at 0:45' }).click();
  await expect(review.getByRole('tab', { name: 'Transcript' })).toHaveAttribute('aria-selected', 'true');
  const row = review.locator(`#segment-${S2}`);
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await row.getByRole('button', { name: 'Play from 0:35' }).click();
  await expect(review.getByRole('tab', { name: 'Recording' })).toHaveAttribute('aria-selected', 'true');
  const audio = review.getByLabel('Meeting recording');
  await expect(audio).toBeFocused();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThanOrEqual(35);
  expect(await audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeLessThan(40);
  await page.keyboard.press('Escape');
  await expect(review).toBeHidden();
  await expect(page.getByRole('button', { name: 'Review' })).toBeFocused();
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);
  await expect(page.getByText('listening', { exact: true })).toBeVisible();
});

test('a note\'s source time focuses its transcript segment', async ({ page }) => {
  await reviewApi(page);
  const review = await openReview(page);
  await review.getByRole('button', { name: 'Show transcript at 0:00' }).click();
  await expect(review.locator(`#segment-${S1}`)).toBeFocused();
});

test('denied and unavailable sources say so while the others still show', async ({ page }) => {
  await reviewApi(page, {
    [`/api/v1/meetings/${MEETING}/recording-access`]: [403, { _tag: 'Forbidden', code: 'forbidden', message: 'Requires recordings:read', retryable: false }],
    [`/api/v1/meetings/${MEETING}/actions`]: unavailable('Receipts are unavailable'),
  });
  const review = await openReview(page);
  await review.getByRole('tab', { name: 'Recording' }).click();
  await expect(review.getByRole('tabpanel', { name: 'Recording' })).toHaveText('Recording not permitted: Requires recordings:read');
  await review.getByRole('tab', { name: 'Transcript' }).click();
  const transcript = review.getByRole('tabpanel', { name: 'Transcript' });
  await expect(transcript.getByRole('listitem')).toHaveCount(3);
  await expect(transcript.getByRole('button')).toHaveCount(0);
  await expect(transcript).not.toContainText('no saved audio');
  await review.getByRole('tab', { name: 'Activity' }).click();
  const activity = review.getByRole('tabpanel', { name: 'Activity' });
  await expect(activity).toContainText('Activity unavailable: Receipts are unavailable');
  await expect(activity.getByRole('listitem')).toHaveText([/^item revised Keep pilot access/]);
});

test('a slow source shows loading on its own tab only', async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>(resolve => (release = resolve));
  await reviewApi(page, { [`/api/v1/meetings/${MEETING}/transcript`]: () => held.then(() => [200, FIXTURES[`/api/v1/meetings/${MEETING}/transcript`]] as const) });
  const review = await openReview(page);
  await expect(review.getByRole('tabpanel', { name: 'Notes' })).toContainText('The team kept the pilot small.');
  await review.getByRole('tab', { name: 'Transcript' }).click();
  await expect(review.getByRole('tabpanel', { name: 'Transcript' })).toHaveText('Loading transcript…');
  release();
  await expect(review.getByRole('tabpanel', { name: 'Transcript' }).getByRole('listitem')).toHaveCount(3);
});

test('no readable meeting is reported on every tab instead of invented data', async ({ page }) => {
  await reviewApi(page, { '/api/v1/meetings': [200, { meetings: [], next_cursor: null }] });
  const review = await openReview(page);
  for (const name of ['Notes', 'Transcript', 'Recording', 'Memory', 'Context', 'Activity']) {
    await review.getByRole('tab', { name }).click();
    await expect(review.getByRole('tabpanel', { name })).toHaveText('No meetings yet.');
  }
});
