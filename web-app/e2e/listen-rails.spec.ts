import type { ActionState } from '@sanctum/contracts';
import { expect, test } from '@playwright/test';
import { openListening, openMeeting } from './listen-fake.ts';

const MEETING = '5f0c6f7e-8d1b-4c2a-9e3f-1a2b3c4d5e6f';
const action = (action_id: string, state: ActionState, title = `Follow-up ${action_id}`) => ({ action_id, action_key: 'google_calendar-create-event', state, title });

test('final live transcript lines arrive in the left rail; partial ones never do', async ({ page }) => {
  await openListening(page);
  const rail = page.getByRole('region', { name: 'Live transcript' });
  await expect(rail).toHaveAttribute('data-live', 'true');
  await page.evaluate(() => window.__capture.transcript('we keep the pil', '0', 'partial'));
  await page.evaluate(() => window.__capture.transcript('we keep the pilot small', '0'));
  await expect(rail.getByText('S0: we keep the pilot small')).toBeVisible();
  await expect(rail.getByText('we keep the pil', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(rail).toHaveAttribute('data-live', 'false');
});

const NOTE = "Live captions use your browser's speech service (in Chrome, Google's).";

test('browser captions show words as they are heard, give way to server segments, and never leave the page', async ({ page }) => {
  const sent: string[] = [];
  page.on('request', request => sent.push(`${new URL(request.url()).search} ${request.postData() ?? ''}`));
  page.on('websocket', socket => socket.on('framesent', frame => sent.push(String(frame.payload))));
  await openListening(page, { speech: true });
  const rail = page.getByRole('region', { name: 'Live transcript' });
  await expect(page.getByText(NOTE)).toBeVisible();
  await page.evaluate(() => window.__speech.say('we keep'));
  await expect(rail.getByText('we keep', { exact: true })).toBeVisible();
  await page.evaluate(() => window.__speech.say('we keep the pilot small and'));
  await expect(rail.getByText('we keep the pilot small and', { exact: true })).toBeVisible();
  // The saved segment replaces every browser word shown so far; the utterance goes on after them.
  await page.evaluate(() => window.__capture.transcript('we keep the pilot small', '0'));
  await expect(rail.getByText('S0: we keep the pilot small')).toBeVisible();
  await expect(rail.getByText('we keep the pilot small and', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.__speech.say('we keep the pilot small and review it Friday', true));
  await expect(rail.getByText('review it Friday', { exact: true })).toBeVisible();
  await page.evaluate(() => window.__capture.transcript('and review it on Friday.', '0'));
  await expect(rail.getByText('S0: and review it on Friday.')).toBeVisible();
  await expect(rail.getByText('review it Friday', { exact: true })).toHaveCount(0);
  // The browser ends sessions on its own; captions restart until the page pauses.
  await page.evaluate(() => window.__speech.end());
  await expect.poll(() => page.evaluate(() => window.__speech.starts)).toBe(2);
  await page.evaluate(() => window.__speech.say('one more thing'));
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(rail.getByText('one more thing')).toHaveCount(0);
  await expect(page.getByText(NOTE)).toHaveCount(0);
  expect(sent.filter(data => /keep|pilot|review|thing/.test(decodeURIComponent(data)))).toEqual([]);
});

test('without browser recognition (as in Firefox) the rail shows only server segments', async ({ page }) => {
  await openListening(page);
  const rail = page.getByRole('region', { name: 'Live transcript' });
  await page.evaluate(() => window.__capture.transcript('we keep the pilot small', '0'));
  await expect(rail.getByText('S0: we keep the pilot small')).toBeVisible();
  await expect(page.getByText(NOTE)).toHaveCount(0);
});

test('a browser caption taller than the rail shows its tail after an ellipsis and stays one line', async ({ page }) => {
  await openListening(page, { speech: true });
  const rail = page.getByRole('region', { name: 'Live transcript' });
  const words = Array.from({ length: 120 }, (_, index) => `word${index}`);
  for (const count of [60, 90, 120]) await page.evaluate(text => window.__speech.say(text), words.slice(0, count).join(' '));
  const caption = rail.locator('.tline.interim');
  await expect(caption).toHaveCount(1);
  await expect(caption).toHaveText(/^…word\d+ .*word119$/);
  await expect(rail.locator('.tline:not(.bye)')).toHaveCount(1);
  await expect
    .poll(async () => {
      const [line, band] = await Promise.all([caption.boundingBox(), rail.locator('.tlines').boundingBox()]);
      return line!.y >= band!.y - 1 && line!.y + line!.height <= band!.y + band!.height + 1;
    })
    .toBe(true);
});

test('a recognition error removes browser captions and their note', async ({ page }) => {
  await openListening(page, { speech: true });
  const rail = page.getByRole('region', { name: 'Live transcript' });
  await page.evaluate(() => window.__speech.say('we keep the pilot'));
  await expect(rail.getByText('we keep the pilot', { exact: true })).toBeVisible();
  await page.evaluate(() => window.__speech.end('network'));
  await expect(rail.getByText('we keep the pilot', { exact: true })).toHaveCount(0);
  await expect(page.getByText(NOTE)).toHaveCount(0);
  expect(await page.evaluate(() => window.__speech.starts)).toBe(1);
});

test("agent work shows the live meeting's actions by title, follows their state and takes a reconnect's snapshot", async ({ page }) => {
  await openListening(page);
  const feed = page.getByRole('region', { name: 'Agent work' });
  await page.evaluate(([meeting, row]) => window.__capture.actions({ meeting_id: meeting, actions: [row] }), [MEETING, action('a1', 'running', 'Book the rollout review')] as const);
  await expect(feed.getByText('Book the rollout review')).toBeVisible();
  await expect(feed.getByText('google_calendar-create-event')).toHaveCount(0);
  await expect(feed.getByText('● executing…')).toBeVisible();
  await page.evaluate(([meeting, row]) => window.__capture.actions({ meeting_id: meeting, actions: [row] }), [MEETING, action('a1', 'succeeded', 'Book the rollout review')] as const);
  await expect(feed.getByText('done ✓')).toBeVisible();
  // After a reconnect the server resends the meeting's current rows: known ones update in place, missed ones appear.
  const snapshot = [action('a1', 'succeeded', 'Book the rollout review'), action('a2', 'queued', 'Email the notes to Dana')];
  await page.evaluate(([meeting, rows]) => window.__capture.actions({ meeting_id: meeting, actions: rows }), [MEETING, snapshot] as const);
  await expect(feed.getByText('Email the notes to Dana')).toBeVisible();
  await expect(feed.getByText('Book the rollout review')).toHaveCount(1);
});

test('rows older than the newest two rest at 40%; rows leave when the meeting closes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openListening(page);
  const feed = page.getByRole('region', { name: 'Agent work' });
  const rows = ['a1', 'a2', 'a3'].map(id => action(id, 'succeeded'));
  await page.evaluate(([meeting, list]) => window.__capture.actions({ meeting_id: meeting, actions: list }), [MEETING, rows] as const);
  const opacity = (title: string) => feed.getByText(title).locator('xpath=..').evaluate(row => getComputedStyle(row).opacity);
  await expect(feed.getByText('Follow-up a3')).toBeVisible();
  await expect(feed.getByText('Follow-up a1')).toBeVisible();
  await expect.poll(() => opacity('Follow-up a1')).toBe('0.4');
  expect(await opacity('Follow-up a2')).toBe('1');
  expect(await opacity('Follow-up a3')).toBe('1');
  await page.evaluate(() => window.__capture.actions({ meeting_id: null, actions: [] }));
  await expect(feed.getByText('Follow-up a3')).toHaveCount(0);
});

test.describe('header', () => {
  test.use({ timezoneId: 'UTC', locale: 'en-US' });

  test('names the open meeting by title, else by start time, and claims nothing without one', async ({ page }) => {
    await openListening(page);
    const header = page.locator('.listen-header');
    await expect(header).toContainText('SANCTUM');
    await expect(header.locator('.listen-meeting')).toHaveCount(0);
    await expect(header).not.toContainText('unavailable');
    await openMeeting(page, MEETING, 'Product sync');
    await expect(header.locator('.listen-meeting')).toHaveText('Product sync');
    await openMeeting(page, '6a1d7e8f-9c2b-4d3a-8f4e-2b3c4d5e6f70', null);
    await expect(header.locator('.listen-meeting')).toHaveText('Meeting since 10:02 AM');
    await page.evaluate(() => window.__capture.actions({ meeting_id: null, actions: [] }));
    await expect(header.locator('.listen-meeting')).toHaveCount(0);
  });
});
