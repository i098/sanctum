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
  await page.route('**/api/v1/meetings?*', route =>
    route.fulfill({ status: 503, json: { _tag: 'Unavailable', code: 'unavailable', message: 'Meeting data unavailable', retryable: false } }));
  await openListening(page);
  await page.getByRole('button', { name: 'Review' }).click();
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveText(['Notes', 'Transcript', 'Recording', 'Memory', 'Context', 'Activity']);
  await tabs.first().focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Activity' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Activity' })).toHaveText('Activity unavailable: Meeting data unavailable');
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
    'Unavailable until sign-in is configured',
    'Not selected: nothing is deleted automatically',
  ]);
});

test('Settings deletes the workspace only after its exact name is typed, and undo restores it', async ({ page, context }) => {
  const live = { id: '11111111-1111-4111-8111-111111111111', name: 'Acme Studio', deleted_at: null, purge_after: null };
  const deleted = { ...live, deleted_at: '2026-10-08T17:00:00.000Z', purge_after: '2026-10-15T17:00:00.000Z' };
  const writes: Array<{ method: string; body: unknown; csrf: string | undefined }> = [];
  let state: object = live;
  await context.addCookies([{ name: 'sanctum_csrf', value: 'csrf-fixture', url: 'http://localhost' }]);
  await page.route(/\/api\/v1\/workspace(\/restore)?$/, route => {
    const request = route.request();
    if (request.method() !== 'GET') {
      writes.push({ method: request.method(), body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] });
      state = request.method() === 'DELETE' ? deleted : live;
    }
    return route.fulfill({ json: state });
  });
  await openListening(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Delete workspace…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete workspace?' });
  const submit = confirm.getByRole('button', { name: 'Delete workspace' });
  await confirm.getByRole('textbox').fill('acme studio');
  await expect(submit).toBeDisabled();
  await confirm.getByRole('textbox').fill('Acme Studio');
  await submit.click();
  await expect(confirm).toBeHidden();
  await expect(settings.getByRole('heading', { name: 'Workspace deleted' })).toBeFocused();
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start', 'pause']);
  await settings.getByRole('button', { name: 'Undo deletion' }).click();
  await expect(settings.getByRole('heading', { name: 'Delete workspace' })).toBeVisible();
  expect(writes).toEqual([
    { method: 'DELETE', body: { confirm_name: 'Acme Studio' }, csrf: 'csrf-fixture' },
    { method: 'POST', body: null, csrf: 'csrf-fixture' },
  ]);
});

test('Settings shows no workspace deletion to anyone the server does not answer as the owner', async ({ page }) => {
  await page.route('**/api/v1/workspace', route => route.fulfill({ status: 403, json: { _tag: 'Forbidden', code: 'forbidden', message: 'Only a workspace owner can manage the workspace', retryable: false } }));
  await openListening(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('heading', { name: 'Recordings of removed listeners' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /workspace/i })).toHaveCount(0);
});
