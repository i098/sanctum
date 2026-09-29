import { expect, test } from '@playwright/test';
import { openListening } from './listen-fake.ts';

for (const name of ['Review', 'Agents', 'Settings']) {
  test(`${name} traps focus, closes on Escape, returns focus, and keeps capture running`, async ({ page }) => {
    await openListening(page);
    const opener = page.getByRole('button', { name });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name });
    await expect(dialog).toBeVisible();
    const frame = (await dialog.boundingBox())!;
    expect(Math.abs(frame.x + frame.width / 2 - 640)).toBeLessThanOrEqual(1);
    const readsWhileOpen = await page.evaluate(() => window.__capture.reads);
    for (let press = 0; press < 12; press++) {
      await page.keyboard.press(press % 3 ? 'Tab' : 'Shift+Tab');
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.__capture.reads)).toBeGreaterThan(readsWhileOpen);
    expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);
    await expect(page.getByText('listening', { exact: true })).toBeVisible();
  });
}

test('Close button closes an overlay and returns focus', async ({ page }) => {
  await openListening(page);
  await page.getByRole('button', { name: 'Agents' }).click();
  await page.getByRole('dialog', { name: 'Agents' }).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Agents' })).toBeFocused();
});

test('Review tabs switch by arrow keys and show truthful unavailable states', async ({ page }) => {
  await openListening(page);
  await page.getByRole('button', { name: 'Review' }).click();
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveText(['Notes', 'Transcript', 'Recording', 'Memory', 'Context', 'Activity']);
  await tabs.first().focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Activity' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Activity' })).toHaveText('Activity unavailable: this listener is not connected to meeting data yet.');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tabpanel', { name: 'Notes' })).toBeVisible();
});

test('Settings reports real device facts and leaves open policies unselected', async ({ page }) => {
  await openListening(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const timezone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  await expect(settings.getByRole('definition')).toHaveText([
    'Not configured: no sign-in provider has been selected',
    'Unavailable until sign-in is configured',
    timezone,
    'Allowed',
    'Unavailable: integrations are not connected yet',
    'Not selected: nothing is deleted automatically',
  ]);
});
