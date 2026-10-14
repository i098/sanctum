import { expect, type Page, test } from '@playwright/test';
import { openListening } from './listen-fake.ts';
import { menuSection } from './menu.ts';

test.use({ locale: 'en-US', timezoneId: 'UTC' });

const OLD = '5f0c6f7e-8d1b-4c2a-9e3f-1a2b3c4d5e6f';
const NEW = '6a1d7a8f-9e2c-4d3b-8f40-2b3c4d5e6f70';
const meeting = (id: string, title: string | null, started_at: string) => ({
  id, workspace_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', state: 'closed', title, started_at, ended_at: null, timezone: 'UTC', boundary_revision: 1, visibility: 'restricted',
  processing: { transcript: 'ready', notes: 'ready', memory: 'ready', recording: 'ready' },
});
const MEETINGS = [meeting(NEW, 'Weekly sync', '2026-10-13T16:00:00Z'), meeting(OLD, 'Pilot review', '2026-09-29T09:00:00Z'), meeting('7b2e8b90-af3d-4e4c-9a51-3c4d5e6f7081', null, '2026-09-01T09:00:00Z')];
const item = (id: string, meeting_id: string | null, kind: string, text: string, state = 'committed') => ({
  id, revision: 1, meeting_id, kind, text, state, derivation: 'spoken', event_at: '2026-09-29T09:00:45Z', valid_from: null, valid_until: null, time: null,
  author: { type: 'system', id: 'extractor' }, sources: [], supersedes: null, created_at: '2026-09-29T09:01:00Z',
});
const FOUND = [
  item('d4e5f6a7-b8c9-4d0e-9f1a-3b4c5d6e7f80', OLD, 'decision', 'Keep pilot access limited to the test group.'),
  item('e5f6a7b8-c9d0-4e1f-8a2b-4c5d6e7f8091', OLD, 'commitment', 'Dana sends the pilot plan.'),
  item('f6a7b8c9-d0e1-4f2a-9b3c-5d6e7f8091a2', OLD, 'preference', 'Prefers pilot notes in email.'),
  item('a7b8c9d0-e1f2-4a3b-8c4d-6e7f8091a2b3', OLD, 'decision', 'Pilot started with the old plan.', 'superseded'),
];

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Menu' });
const box = (page: Page) => dialog(page).getByRole('combobox', { name: 'Search' });
const rows = (page: Page) => dialog(page).getByRole('option');

/** Fixture v1 routes: the meeting list, `GET /context/search` (recorded by query), and each meeting by id. */
async function api(page: Page, searched: string[], search: () => readonly [number, unknown] = () => [200, { items: FOUND }]) {
  await page.route('**/api/v1/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/meetings') return route.fulfill({ json: { meetings: MEETINGS, next_cursor: null } });
    if (url.pathname === '/api/v1/context/search') {
      searched.push(`${url.searchParams.get('q')!}@${url.searchParams.get('limit')}`);
      const [status, json] = search();
      return route.fulfill({ status, json });
    }
    const chosen = MEETINGS.find(({ id }) => url.pathname === `/api/v1/meetings/${id}`);
    return chosen ? route.fulfill({ json: chosen }) : route.fulfill({ status: 503, json: { _tag: 'Unavailable', code: 'unavailable', message: 'fixture has no more', retryable: false } });
  });
}

async function openSearch(page: Page) {
  await openListening(page);
  await page.keyboard.press('Control+k');
  await expect(box(page)).toBeFocused();
}

test('a query finds decisions, commitments and meeting titles; Enter opens the meeting in Review', async ({ page }) => {
  const searched: string[] = [];
  await api(page, searched);
  await openSearch(page);
  await box(page).fill('pilot');
  await expect(rows(page)).toHaveText([
    'MeetingPilot reviewSep 29, 2026',
    'DecisionKeep pilot access limited to the test group.Pilot review · Sep 29, 2026',
    'CommitmentDana sends the pilot plan.Pilot review · Sep 29, 2026',
  ]);
  expect(searched).toEqual(['pilot@200']);
  await expect(dialog(page)).toContainText('not transcript text');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(rows(page).nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(rows(page).first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(box(page)).toHaveValue('');
  await expect(menuSection(page, 'Review')).toContainText('Pilot review · closed · started 9/29/2026, 9:00:00 AM');
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);
});

test('commands open a section; Escape clears the box first, then closes the Menu', async ({ page }) => {
  await api(page, []);
  await openSearch(page);
  await box(page).fill('settings');
  await expect(rows(page)).toHaveText(['SectionOpen Settings']);
  await page.keyboard.press('Enter');
  await expect(menuSection(page, 'Settings')).toBeVisible();
  await box(page).fill('agents');
  await page.keyboard.press('Escape');
  await expect(box(page)).toHaveValue('');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
  await expect(page.getByText('listening', { exact: true })).toBeVisible();
});

test('a failing decision search says so and still shows matching meeting titles', async ({ page }) => {
  await api(page, [], () => [503, { _tag: 'Unavailable', code: 'unavailable', message: 'Context search is down', retryable: false }]);
  await openSearch(page);
  await box(page).fill('pilot');
  await expect(dialog(page)).toContainText('Decisions and commitments unavailable: Context search is down');
  await expect(rows(page)).toHaveText(['MeetingPilot reviewSep 29, 2026']);
});

test('a query with no match says so', async ({ page }) => {
  await api(page, [], () => [200, { items: [] }]);
  await openSearch(page);
  await box(page).fill('zzz');
  await expect(dialog(page)).toContainText('No match for “zzz”.');
});
