import { expect, test } from '@playwright/test';

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1024, height: 640 },
]) {
  test(`fills ${viewport.width}x${viewport.height} with the canvas and does not scroll`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const main = page.getByRole('main', { name: 'Sanctum' });
    await expect(main).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(10, 12, 16)');
    await expect(main).toHaveCSS('background-color', 'rgb(10, 12, 16)');
    const size = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
    }));
    expect(size.scrollHeight).toBeLessThanOrEqual(size.innerHeight);
    expect(size.scrollWidth).toBeLessThanOrEqual(size.innerWidth);
  });
}
