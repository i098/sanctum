import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/** The built landing page (npm run build -w web-app), served at the apex as the Worker serves it. */
const LANDING_ROOT = fileURLToPath(new URL('../landing/dist/', import.meta.url));
const APEX = 'https://sanctum.42nights.dev';

test.beforeAll(() => {
  if (!existsSync(LANDING_ROOT)) throw new Error('Build the landing page first: npm run build -w web-app');
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`at ${viewport.width}x${viewport.height} the hero and both calls to action fit the first screen`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route(`${APEX}/**`, route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: `${LANDING_ROOT}${path === '/' ? 'index.html' : path.slice(1)}` });
    });
    await page.goto(`${APEX}/`);

    const hero = page.getByRole('region', { name: 'The room remembers.' });
    await expect(hero.getByRole('heading', { level: 1 })).toBeInViewport();
    const open = hero.getByRole('link', { name: 'Open Sanctum' });
    const selfHost = hero.getByRole('link', { name: 'Self-host from GitHub' });
    await expect(open).toBeInViewport();
    await expect(open).toHaveAttribute('href', 'https://app.sanctum.42nights.dev/');
    await expect(selfHost).toBeInViewport();
    await expect(selfHost).toHaveAttribute('href', 'https://github.com/i098/sanctum');
    // The waveform draws: some canvas pixel is no longer transparent.
    await expect.poll(() => hero.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
      const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      return data.some((value, index) => index % 4 === 3 && value > 0);
    })).toBe(true);
    const size = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    expect(size.scrollWidth).toBeLessThanOrEqual(size.innerWidth);
  });
}
