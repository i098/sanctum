/** Fullscreen belongs to the Menu's Display section and the F key; in fullscreen the footer steps back when nothing moves. */
import { expect, test, type Page } from '@playwright/test';
import { openListening } from './listen-fake.ts';
import { menuSection, openMenu } from './menu.ts';

const fullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement !== null);
const footer = (page: Page) => page.locator('.listen-footer');

test('F toggles fullscreen, except while typing in a control, and the footer has no Fullscreen button', async ({ page }) => {
  await openListening(page);
  await expect(page.getByRole('navigation', { name: 'Listening controls' }).getByRole('button', { name: 'Fullscreen' })).toHaveCount(0);
  await page.keyboard.press('f');
  await expect.poll(() => fullscreen(page)).toBe(true);
  await page.keyboard.press('F');
  await expect.poll(() => fullscreen(page)).toBe(false);

  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'typed';
    document.querySelector('main')!.append(input);
    input.focus();
  });
  await page.keyboard.press('f');
  await page.keyboard.press('Control+f');
  expect(await fullscreen(page)).toBe(false);
  expect(await page.locator('#typed').inputValue()).toBe('f');
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);
});

test('the Display section enters fullscreen and closes the panel; F leaves it', async ({ page }) => {
  await openListening(page);
  const display = await openMenu(page, 'Display');
  await display.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(() => fullscreen(page)).toBe(true);
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden();

  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('dialog', { name: 'Menu' }).getByRole('navigation', { name: 'Menu sections' }).getByRole('button', { name: 'Display' }).click();
  await expect(menuSection(page, 'Display').getByRole('button', { name: 'Exit fullscreen' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('f');
  await expect.poll(() => fullscreen(page)).toBe(false);
});

test('in fullscreen the footer fades after 3 s without input and returns on movement; outside fullscreen it never fades', async ({ page }) => {
  await openListening(page);
  await expect(footer(page)).toHaveCSS('opacity', '1');
  await page.waitForTimeout(3_500);
  await expect(footer(page)).toHaveCSS('opacity', '1');

  await page.keyboard.press('f');
  await expect.poll(() => fullscreen(page)).toBe(true);
  await expect(footer(page)).toHaveCSS('opacity', '0.25', { timeout: 6_000 });
  await page.mouse.move(300, 300);
  await expect(footer(page)).toHaveCSS('opacity', '1');
  await expect(footer(page)).toHaveCSS('opacity', '0.25', { timeout: 6_000 });
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);
});

test('a warning keeps the footer in view in fullscreen', async ({ page }) => {
  await openListening(page);
  await page.keyboard.press('f');
  await expect.poll(() => fullscreen(page)).toBe(true);
  await page.evaluate(() => window.__capture.update({ listener: 'degraded', issue: 'silent_input', inputLabel: 'Mic' }));
  await page.waitForTimeout(4_000);
  await expect(footer(page)).toHaveCSS('opacity', '1');
});
