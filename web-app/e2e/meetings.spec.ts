import { expect, test } from '@playwright/test';
import { openListening } from './listen-fake.ts';
import { menuSection, openMenu } from './menu.ts';

test.use({ locale: 'en-US', timezoneId: 'UTC' });

const id = (n: number) => `5f0c6f7e-8d1b-4c2a-9e3f-1a2b3c4d5e${String(n).padStart(2, '0')}`;
const meeting = (n: number, title: string | null, state: string) => ({ id: id(n), title, state, started_at: `2026-10-${String(30 - n).padStart(2, '0')}T09:00:00Z`, timezone: 'UTC' });
const notes = (n: number) => ({ meeting_id: id(n), revision: 1, boundary_revision: 1, model: 'fixture', title: `Notes of ${n}`, summary: `Summary of meeting ${n}.`, sections: [], generated_at: '2026-10-14T09:00:00Z' });

/** 25 meetings in two pages; the live one is in the middle of the first page, not first. */
async function serve(page: import('@playwright/test').Page) {
  const asked: string[] = [];
  await page.route('**/api/v1/meetings?*', route => {
    const params = new URL(route.request().url()).searchParams;
    asked.push(params.toString());
    const rest = params.get('cursor') === 'p2';
    const meetings = rest
      ? Array.from({ length: 5 }, (_, index) => meeting(21 + index, `Older ${21 + index}`, 'closed'))
      : Array.from({ length: 20 }, (_, index) => meeting(index + 1, index === 3 ? 'Live standup' : index === 4 ? null : `Meeting ${index + 1}`, index === 3 ? 'active' : 'closed'));
    return route.fulfill({ json: { meetings, next_cursor: rest ? null : 'p2' } });
  });
  await page.route(/\/api\/v1\/meetings\/[^/]+\/notes$/, route => route.fulfill({ json: notes(Number(/\/meetings\/[^/]+(\d\d)\/notes/.exec(route.request().url())![1])) }));
  return asked;
}

test('Meetings lists the live meeting on top and opens any meeting\'s Review, not just the newest', async ({ page }) => {
  const asked = await serve(page);
  await openListening(page);
  const meetings = await openMenu(page, 'Meetings');
  await expect(meetings.getByRole('region', { name: 'Now' }).getByRole('button')).toHaveText(['Live standuplive · Mon, Oct 26, 9:00 AM']);
  await expect(meetings.getByRole('region', { name: 'Recent' }).getByRole('button').nth(3)).toHaveText(/^Untitled meeting/);
  // Side by side, the live meeting is already open.
  await expect(meetings.getByRole('tabpanel', { name: 'Notes' })).toContainText('Summary of meeting 4.');
  await meetings.getByRole('button', { name: /^Meeting 2 / }).click();
  await expect(meetings.getByRole('button', { name: /^Meeting 2 / })).toHaveAttribute('aria-current', 'true');
  await expect(meetings.getByRole('tabpanel', { name: 'Notes' })).toContainText('Summary of meeting 2.');
  await expect(meetings.getByRole('tab')).toHaveText(['Notes', 'Transcript', 'Recording', 'Memory', 'Context', 'Activity']);

  await meetings.getByRole('button', { name: 'Load more' }).click();
  await expect(meetings.getByRole('button', { name: /^Older 25 / })).toBeVisible();
  await expect(meetings.getByRole('button', { name: 'Load more' })).toBeHidden();
  expect(asked.filter(query => query.includes('cursor'))).toEqual(['cursor=p2&limit=20']);
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);
});

test('Meetings says why the list is missing and offers another try', async ({ page }) => {
  let failing = true;
  await page.route('**/api/v1/meetings?*', route =>
    failing
      ? route.fulfill({ status: 503, json: { _tag: 'Unavailable', code: 'unavailable', message: 'Meeting data unavailable', retryable: false } })
      : route.fulfill({ json: { meetings: [], next_cursor: null } }));
  await openListening(page);
  const meetings = await openMenu(page, 'Meetings');
  await expect(meetings.getByRole('alert')).toHaveText('Meetings unavailable: Meeting data unavailable');
  failing = false;
  await meetings.getByRole('button', { name: 'Try again' }).click();
  await expect(meetings).toContainText('No meetings yet.');
  await expect(meetings.getByRole('alert')).toBeHidden();
});

test('On a phone Meetings shows the list first, the chosen meeting over it, and a way back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serve(page);
  await openListening(page);
  const meetings = await openMenu(page, 'Meetings');
  await expect(meetings.getByRole('tab')).toHaveCount(0);
  await meetings.getByRole('button', { name: /^Meeting 2 / }).click();
  await expect(meetings.getByRole('tabpanel', { name: 'Notes' })).toContainText('Summary of meeting 2.');
  await expect(meetings.getByRole('button', { name: /^Meeting 3 / })).toBeHidden();
  await meetings.getByRole('button', { name: '‹ Meetings' }).click();
  await expect(meetings.getByRole('button', { name: /^Meeting 3 / })).toBeVisible();
  await expect(menuSection(page, 'Meetings').getByRole('tab')).toHaveCount(0);
});
