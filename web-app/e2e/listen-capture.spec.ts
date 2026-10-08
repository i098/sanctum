/** Integration: the listening page drives the real capture engine (no test-side engine). */
import { expect, test } from '@playwright/test';
import { fakeServer } from './capture-server.ts';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test('page controls start the real engine, overlays leave capture running, pause stops it', async ({ page }) => {
  const server = await fakeServer(page);
  await page.goto('/');
  const state = page.locator('.listen-state');
  await expect(state).toHaveText('stopped');

  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(state).toHaveText('listening', { timeout: 15_000 });
  await expect.poll(() => server.starts.length).toBe(1);
  await expect.poll(() => server.frames, { timeout: 10_000 }).toBeGreaterThan(5);

  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByRole('dialog', { name: 'Review' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const framesAfterOverlay = server.frames;
  await expect.poll(() => server.frames, { timeout: 10_000 }).toBeGreaterThan(framesAfterOverlay);
  await expect(state).toHaveText('listening');
  expect(server.starts).toHaveLength(1);

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(state).toHaveText('paused', { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
});

test('names lost live transcription while the audio keeps streaming', async ({ page }) => {
  const server = await fakeServer(page, false, 'provider_unavailable');
  await page.goto('/');
  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(page.locator('.listen-state')).toHaveText('degraded', { timeout: 15_000 });
  await expect(page.locator('.listen-helper[data-warning="true"]')).toContainText('transcription');
  const frames = server.frames;
  await expect.poll(() => server.frames, { timeout: 10_000 }).toBeGreaterThan(frames);
});
