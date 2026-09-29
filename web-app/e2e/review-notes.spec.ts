import { expect, test } from '@playwright/test';
import { openListening } from './listen-fake.ts';

const MEETING = '5f0c6f7e-8d1b-4c2a-9e3f-1a2b3c4d5e6f';
const notes = {
  meeting_id: MEETING,
  revision: 2,
  boundary_revision: 1,
  model: 'fixture',
  title: 'Pilot review',
  summary: 'The team kept the pilot small and set the beta date.',
  sections: [{ heading: 'Next steps', points: [{ text: 'Beta ships on Friday.', sources: [{ segment_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', start_ms: 65_000, end_ms: 70_000 }] }] }],
  generated_at: '2026-09-29T09:00:00Z',
};

test('Review Notes shows the canonical summary of the latest meeting with source times', async ({ page }) => {
  await page.route('**/api/v1/meetings?*', route => route.fulfill({ json: { meetings: [{ id: MEETING }], next_cursor: null } }));
  await page.route(`**/api/v1/meetings/${MEETING}/notes`, route => route.fulfill({ json: notes }));
  await openListening(page);
  await page.getByRole('button', { name: 'Review' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Notes' });
  await expect(panel.getByRole('heading', { name: 'Pilot review' })).toBeVisible();
  await expect(panel).toContainText('The team kept the pilot small and set the beta date.');
  await expect(panel.getByRole('listitem')).toHaveText('Beta ships on Friday. 1:05');
});

test('Review Notes says why notes are missing instead of inventing them', async ({ page }) => {
  await page.route('**/api/v1/meetings?*', route => route.fulfill({ json: { meetings: [{ id: MEETING }], next_cursor: null } }));
  await page.route(`**/api/v1/meetings/${MEETING}/notes`, route =>
    route.fulfill({ status: 503, json: { _tag: 'Unavailable', code: 'unavailable', message: 'Notes are not ready yet', retryable: true } }));
  await openListening(page);
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Notes' })).toHaveText('Notes unavailable: Notes are not ready yet');
});
