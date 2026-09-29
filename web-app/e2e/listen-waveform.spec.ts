import { expect, test } from '@playwright/test';
import { openListening, waveProfile } from './listen-fake.ts';

test('the real engine never claims capture when the API is unreachable', async ({ page }) => {
  await page.route('**/api/v1/**', route => route.fulfill({ status: 503, json: { _tag: 'Unavailable', code: 'unavailable', retryable: true, message: 'offline' } }));
  await page.goto('/');
  await expect(page.getByText('stopped', { exact: true })).toBeVisible();
  await expect(page.getByText('Silent · not recording')).toBeVisible();
  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(page.locator('.listen-helper[data-warning="true"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.listen-state')).not.toHaveText('listening');
  expect((await waveProfile(page)).rise).toBeLessThanOrEqual(1);
});

test('real audio draws irregular asymmetric needles with quick attack and slow release', async ({ page }) => {
  await openListening(page);
  expect((await waveProfile(page)).rise).toBeLessThanOrEqual(1);

  await page.evaluate(() => window.__capture.setGain(0.8));
  await page.waitForTimeout(150);
  const attack = await waveProfile(page);
  await page.waitForTimeout(500);
  const loud = await waveProfile(page);
  expect(attack.rise).toBeGreaterThan(loud.rise * 0.6);
  expect(loud.rise).toBeGreaterThan(40);
  expect(loud.fall).toBeLessThan(loud.rise * 0.85);
  expect(loud.fall).toBeGreaterThan(loud.rise * 0.2);
  expect(loud.needles).toBeGreaterThanOrEqual(8);

  await page.evaluate(() => window.__capture.setGain(0));
  await page.waitForTimeout(120);
  expect((await waveProfile(page)).rise).toBeGreaterThan(loud.rise * 0.4);
  await page.waitForTimeout(2500);
  expect((await waveProfile(page)).rise).toBeLessThanOrEqual(1);
});

test('pause settles to a subdued line and resume returns to live levels', async ({ page }) => {
  await openListening(page);
  await page.evaluate(() => window.__capture.setGain(0.8));
  const live = await waveProfile(page);
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('paused', { exact: true })).toBeVisible();
  await page.waitForTimeout(2500);
  const paused = await waveProfile(page);
  expect(paused.rise).toBeLessThanOrEqual(1);
  expect(paused.brightness).toBeLessThan(live.brightness * 0.6);
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText('listening', { exact: true })).toBeVisible();
  await expect.poll(async () => (await waveProfile(page)).rise).toBeGreaterThan(40);
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start', 'pause', 'resume']);
});

test('hidden page stops drawing without stopping capture', async ({ page }) => {
  await openListening(page);
  const reads = (): Promise<number> => page.evaluate(() => window.__capture.reads);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hidden = await reads();
  await page.waitForTimeout(500);
  expect(await reads()).toBe(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(reads).toBeGreaterThan(hidden);
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);
  await expect(page.getByText('listening', { exact: true })).toBeVisible();
});

test('reduced motion limits movement but keeps capture and state readable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openListening(page);
  await page.evaluate(() => window.__capture.setGain(0.8));
  await page.waitForTimeout(1000);
  const before = await page.evaluate(() => window.__capture.reads);
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__capture.reads) - before).toBeLessThanOrEqual(5);
  const reduced = await waveProfile(page);
  expect(reduced.rise).toBeGreaterThan(5);
  expect(reduced.rise).toBeLessThan(0.45 * 0.2 * 720);
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);
});

test('capture interruption is shown truthfully and flattens the waveform', async ({ page }) => {
  await openListening(page);
  await page.evaluate(() => window.__capture.setGain(0.8));
  await expect.poll(async () => (await waveProfile(page)).rise).toBeGreaterThan(40);
  await page.evaluate(() => window.__capture.update({ listener: 'reconnecting', archive: 'interrupted', issue: 'socket_unavailable', bufferedChunks: 3 }));
  await expect(page.getByText('reconnecting', { exact: true })).toBeVisible();
  await expect(page.getByText('The server connection is unavailable.')).toBeVisible();
  const health = page.getByText('Silent · recording interrupted · 3 chunks pending');
  await expect(health).toHaveAttribute('data-tone', 'warning');
  await expect.poll(async () => (await waveProfile(page)).rise, { timeout: 5000 }).toBeLessThanOrEqual(1);
});
