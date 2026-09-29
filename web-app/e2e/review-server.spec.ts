import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { openListening } from './listen-fake.ts';

/**
 * Review against the real API server and database (server/tests/support/review-server.ts). The
 * page's same-origin `/api/v1` calls are forwarded to it with a bearer token standing in for the
 * browser session, and the signed recording URL is read from its object store.
 */
test.use({ locale: 'en-US', timezoneId: 'UTC' });

let child: ChildProcess;
let server: { url: string; objects: string; token: string };
test.beforeAll(async () => {
  const script = fileURLToPath(new URL('../../server/tests/support/review-server.ts', import.meta.url));
  child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  // Request logs share stdout and keep being read; the JSON line is the address.
  const lines = createInterface({ input: child.stdout! });
  server = JSON.parse(await new Promise<string>(resolve => lines.on('line', line => line.startsWith('{') && resolve(line))));
});
test.afterAll(async () => {
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
});

test('Review reads the real meeting, and a decision\'s source plays its authorized audio', async ({ page }) => {
  await page.route('**/api/v1/**', async route => {
    const { pathname, search } = new URL(route.request().url());
    const headers = { ...route.request().headers(), authorization: `Bearer ${server.token}` };
    await route.fulfill({ response: await route.fetch({ url: `${server.url}${pathname}${search}`, headers }) });
  });
  await page.route('https://objects.test/**', async route => {
    const { pathname, search } = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${server.objects}${pathname}${search}` }) });
  });
  await openListening(page);
  await page.getByRole('button', { name: 'Review' }).click();
  const review = page.getByRole('dialog', { name: 'Review' });
  await expect(review).toContainText('closed');
  // No worker runs here, so notes are truthfully not ready.
  await expect(review.getByRole('tabpanel', { name: 'Notes' })).toHaveText(/^Notes unavailable: /);

  await review.getByRole('tab', { name: 'Memory' }).click();
  await expect(review.getByRole('tabpanel', { name: 'Memory' }).getByRole('listitem')).toHaveText([/^decision Keep pilot access limited to the test group\. committed · human correction · revision 2 0:45$/]);
  await review.getByRole('tab', { name: 'Context' }).click();
  const context = review.getByRole('tabpanel', { name: 'Context' });
  await expect(context.getByRole('listitem')).toHaveCount(2);
  await expect(context).toContainText('commitment Dana sends the pilot plan. provisional · human correction · revision 1 0:00');
  await review.getByRole('tab', { name: 'Activity' }).click();
  const activity = review.getByRole('tabpanel', { name: 'Activity' });
  await expect(activity.getByRole('listitem').first()).toHaveText(/^gmail-send-email succeeded 1 attempt/);
  await expect(activity).toContainText('item added Dana sends the pilot plan. (revision 1)');
  await expect(activity).toContainText('item revised Keep pilot access limited to the test group. (revision 2)');

  await review.getByRole('tab', { name: 'Memory' }).click();
  await review.getByRole('button', { name: 'Show transcript at 0:45' }).click();
  const transcript = review.getByRole('tabpanel', { name: 'Transcript' });
  const row = transcript.getByRole('listitem').filter({ hasText: 'Keep pilot access to the test group.' });
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(transcript.getByRole('listitem').filter({ hasText: 'Said while the laptop slept.' })).toContainText('no saved audio');
  // Source second 45 sits after 10 unsaved seconds, so the assembled file plays it at second 35.
  await row.getByRole('button', { name: 'Play from 0:35' }).click();
  const audio = review.getByLabel('Meeting recording');
  await expect(audio).toBeFocused();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThanOrEqual(35);
  expect(await audio.evaluate((element: HTMLAudioElement) => element.duration)).toBeCloseTo(45, 0);
  await expect(review.getByRole('tabpanel', { name: 'Recording' })).toContainText('One part of this meeting has no saved audio; playback skips it.');
  await page.keyboard.press('Escape');
  await expect(review).toBeHidden();
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);
});
