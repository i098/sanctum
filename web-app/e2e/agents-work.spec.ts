import { expect, test } from '@playwright/test';
import { openListening } from './listen-fake.ts';
import { openMenu } from './menu.ts';

test.use({ locale: 'en-US', timezoneId: 'UTC' });

const OLD = '5f0c6f7e-8d1b-4c2a-9e3f-1a2b3c4d5e6f';
const NEW = '6a1d7e8f-9e2c-4d3b-8f4a-2b3c4d5e6f70';
const meeting = (id: string, title: string | null, state: string, started_at: string) => ({ id, title, state, started_at, timezone: 'UTC' });
const receipt = (action_id: string, action_key: string, state: string) => ({
  action_id, action_key, meeting_id: OLD, state, args_sha256: 'a'.repeat(64), grant: null, provider_receipt: null, attempts: 1, reconciliation: 'none', updated_at: '2026-09-29T09:20:00Z',
});

test('Agents opens on Work: recent meetings\' receipts, refreshed by a live update, beside Access tokens', async ({ page }) => {
  let actions = [receipt('f6a7b8c9-d0e1-4f2a-9b3c-5d6e7f8091a2', 'gmail-send-email', 'running')];
  await page.route('**/api/v1/meetings?*', route =>
    route.fulfill({ json: { meetings: [meeting(NEW, null, 'active', '2026-09-30T10:00:00Z'), meeting(OLD, 'Pilot review', 'closed', '2026-09-29T09:00:00Z')], next_cursor: null } }));
  await page.route(`**/api/v1/meetings/${OLD}/actions*`, route => route.fulfill({ json: { actions, next_cursor: null } }));
  await page.route(`**/api/v1/meetings/${NEW}/actions*`, route => route.fulfill({ json: { actions: [], next_cursor: null } }));
  await page.route('**/api/v1/agents**', route => route.fulfill({ json: { items: [], next_cursor: null } }));
  await openListening(page);
  const agents = await openMenu(page, 'Agents');

  await expect(agents.getByRole('tab', { name: 'Work' })).toHaveAttribute('aria-selected', 'true');
  await expect(agents.getByRole('region', { name: 'Untitled meeting' })).toContainText('No actions were requested in this meeting.');
  const pilot = agents.getByRole('region', { name: 'Pilot review' });
  await expect(pilot).toContainText('closed · 9/29/2026');
  await expect(pilot.getByRole('listitem')).toHaveText(['Gmail · Send email Running 1 attempt · 09:20 AM']);

  await expect(pilot.locator('.listen-work-state')).toHaveAttribute('data-tone', 'muted');
  actions = [{ ...actions[0]!, state: 'succeeded' }];
  await page.evaluate(meeting_id => window.__capture.actions({ meeting_id, actions: [] }), OLD);
  await expect(pilot.getByRole('listitem')).toHaveText(['Gmail · Send email Succeeded 1 attempt · 09:20 AM']);
  await expect(pilot.locator('.listen-work-state')).toHaveAttribute('data-tone', 'done');

  await agents.getByRole('tab', { name: 'Access tokens' }).click();
  await expect(agents.getByText('No agents yet.')).toBeVisible();
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);
});

test('Work says so when receipts cannot be read, and when there are no meetings', async ({ page }) => {
  await page.route('**/api/v1/meetings?*', route => route.fulfill({ status: 503, json: { _tag: 'Unavailable', code: 'unavailable', message: 'Meeting data unavailable', retryable: false } }));
  await openListening(page);
  const agents = await openMenu(page, 'Agents');
  await expect(agents).toContainText('Activity unavailable: Meeting data unavailable');
});

test('a slow, older meetings read never replaces the newer one a live update started', async ({ page }) => {
  let live = false;
  let reads = 0;
  const pilot = meeting(OLD, 'Pilot review', 'closed', '2026-09-29T09:00:00Z');
  await page.route('**/api/v1/meetings?*', async route => {
    if (!route.request().url().includes('limit=5')) return route.fulfill({ json: { meetings: [], next_cursor: null } });
    if (!live) return route.fulfill({ json: { meetings: [pilot], next_cursor: null } });
    // The first read after the update is slow and stale; the second is fast and sees the new meeting.
    if (++reads === 1) {
      await new Promise(done => setTimeout(done, 1000));
      return route.fulfill({ json: { meetings: [pilot], next_cursor: null } });
    }
    return route.fulfill({ json: { meetings: [meeting(NEW, 'Fresh meeting', 'active', '2026-09-30T10:00:00Z'), pilot], next_cursor: null } });
  });
  await page.route('**/api/v1/meetings/*/actions*', route => route.fulfill({ json: { actions: [], next_cursor: null } }));
  await page.route('**/api/v1/agents**', route => route.fulfill({ json: { items: [], next_cursor: null } }));
  await openListening(page);
  const agents = await openMenu(page, 'Agents');
  await expect(agents.getByRole('region', { name: 'Pilot review' })).toBeVisible();

  live = true;
  // Neither update names a meeting the panel knows, so each starts its own read.
  for (const _ of [1, 2]) await page.evaluate(meeting_id => window.__capture.actions({ meeting_id, actions: [] }), NEW);
  await expect(agents.getByRole('region', { name: 'Fresh meeting' })).toBeVisible();
  await expect.poll(() => reads).toBe(2);
  await page.waitForTimeout(1300);
  await expect(agents.getByRole('region', { name: 'Fresh meeting' })).toBeVisible();
});
