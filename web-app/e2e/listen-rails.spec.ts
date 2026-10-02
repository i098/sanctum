import { expect, test } from '@playwright/test';
import { openListening } from './listen-fake.ts';

const MEETING = '5f0c6f7e-8d1b-4c2a-9e3f-1a2b3c4d5e6f';
const receipt = (state: string) => ({
  action_id: 'a1', action_key: 'google_calendar-create-event', meeting_id: MEETING, state, args_sha256: 'a'.repeat(64), grant: null,
  provider_receipt: null, attempts: 1, reconciliation: 'none', updated_at: '2026-09-29T09:20:00Z',
});

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

test("agent work shows the open meeting's action receipts and their state changes", async ({ page }) => {
  let state = 'running';
  await page.route('**/api/v1/meetings?*', route =>
    route.fulfill({ json: { meetings: [{ id: MEETING, title: null, state: 'active', started_at: '2026-09-29T09:00:00Z', timezone: 'UTC' }], next_cursor: null } }));
  await page.route(`**/api/v1/meetings/${MEETING}/actions*`, route => route.fulfill({ json: { actions: [receipt(state)], next_cursor: null } }));
  await openListening(page);
  const feed = page.getByRole('region', { name: 'Agent work' });
  await expect(feed.getByText('google_calendar-create-event')).toBeVisible();
  await expect(feed.getByText('● executing…')).toBeVisible();
  state = 'succeeded';
  await expect(feed.getByText('done ✓')).toBeVisible({ timeout: 8_000 });
});

test('rows older than the newest two rest at 40%; a row leaves when its meeting closes', async ({ page }) => {
  let meetingState = 'active';
  const actions = ['a1', 'a2', 'a3', 'a4'].map(id => ({ ...receipt('succeeded'), action_id: id, action_key: `research-${id}` }));
  await page.route('**/api/v1/meetings?*', route =>
    route.fulfill({ json: { meetings: [{ id: MEETING, title: null, state: meetingState, started_at: '2026-09-29T09:00:00Z', timezone: 'UTC' }], next_cursor: null } }));
  await page.route(`**/api/v1/meetings/${MEETING}/actions*`, route => route.fulfill({ json: { actions, next_cursor: null } }));
  await openListening(page);
  const feed = page.getByRole('region', { name: 'Agent work' });
  const opacity = (key: string) => feed.getByText(key).locator('xpath=..').evaluate(row => getComputedStyle(row).opacity);
  await expect(feed.getByText('research-a4')).toBeVisible();
  await expect.poll(() => opacity('research-a1')).toBe('0.4');
  await expect.poll(() => opacity('research-a2')).toBe('0.4');
  expect(await opacity('research-a3')).toBe('1');
  expect(await opacity('research-a4')).toBe('1');
  meetingState = 'closed';
  await expect(feed.getByText('research-a4')).toHaveCount(0, { timeout: 8_000 });
});
