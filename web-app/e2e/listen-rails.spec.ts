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
