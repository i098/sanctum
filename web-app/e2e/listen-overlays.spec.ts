import { expect, test, type Page } from '@playwright/test';
import { openListening } from './listen-fake.ts';
import { menuSection, openMenu } from './menu.ts';

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Menu' });

for (const name of ['Meetings', 'Agents', 'Settings']) {
  test(`Menu on ${name} traps focus, closes on Escape, returns focus, and keeps capture running`, async ({ page }) => {
    await openListening(page);
    const opener = page.getByRole('button', { name: 'Menu' });
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole('navigation', { name: 'Menu sections' }).getByRole('button', { name }).click();
    await expect(menuSection(page, name)).toBeVisible();
    const frame = (await dialog(page).boundingBox())!;
    expect(Math.abs(frame.x + frame.width / 2 - 640)).toBeLessThanOrEqual(1);
    const readsWhileOpen = await page.evaluate(() => window.__capture.reads);
    for (let press = 0; press < 12; press++) {
      await page.keyboard.press(press % 3 ? 'Tab' : 'Shift+Tab');
      expect(await dialog(page).evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(opener).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.__capture.reads)).toBeGreaterThan(readsWhileOpen);
    expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);
    await expect(page.getByText('listening', { exact: true })).toBeVisible();
  });
}

test('Ctrl+K opens the Menu from anywhere on the page and Escape returns focus to the Menu button', async ({ page }) => {
  await openListening(page);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+k');
  await expect(dialog(page)).toBeVisible();
  await expect(menuSection(page, 'Meetings')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);
});

test('Cmd+K with Caps Lock on (an uppercase K) still opens the Menu', async ({ page }) => {
  await openListening(page);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Meta+K');
  await expect(dialog(page)).toBeVisible();
});

test('Sections switch inside the open Menu without closing it', async ({ page }) => {
  await openListening(page);
  await openMenu(page, 'Meetings');
  await dialog(page).getByRole('button', { name: 'Agents' }).click();
  await expect(menuSection(page, 'Agents')).toBeVisible();
  await expect(menuSection(page, 'Meetings')).toBeHidden();
  await expect(dialog(page).getByRole('button', { name: 'Agents' })).toHaveAttribute('aria-current', 'page');
});

test('Close button closes the Menu and returns focus', async ({ page }) => {
  await openListening(page);
  await openMenu(page, 'Agents');
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
});

test('Review tabs switch by arrow keys and show truthful unavailable states', async ({ page }) => {
  await page.route('**/api/v1/meetings?*', route => route.fulfill({ json: { meetings: [{ id: '5f0c6f7e-8d1b-4c2a-9e3f-1a2b3c4d5e6f', title: 'Pilot review', state: 'closed', started_at: '2026-09-29T09:00:00Z', timezone: 'UTC' }], next_cursor: null } }));
  await page.route(/\/api\/v1\/(meetings\/|context\/)/, route =>
    route.fulfill({ status: 503, json: { _tag: 'Unavailable', code: 'unavailable', message: 'Meeting data unavailable', retryable: false } }));
  await openListening(page);
  await openMenu(page, 'Meetings');
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveText(['Notes', 'Transcript', 'Recording', 'Memory', 'Context', 'Activity']);
  await tabs.first().focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Activity' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Activity' })).toContainText('Activity unavailable: Meeting data unavailable');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tabpanel', { name: 'Notes' })).toBeVisible();
});

test('Settings reports real device facts and leaves open policies unselected', async ({ page }) => {
  await openListening(page);
  await openMenu(page, 'Settings');
  const settings = menuSection(page, 'Settings');
  const timezone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  await expect(settings.getByRole('definition')).toHaveText([
    'Not configured: no sign-in provider has been selected',
    'Unavailable until sign-in is configured',
    timezone,
    'Allowed',
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
  await openMenu(page, 'Settings');
  const settings = menuSection(page, 'Settings');
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
  await openMenu(page, 'Settings');
  await expect(menuSection(page, 'Settings').getByRole('heading', { name: 'Recordings of removed listeners' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /workspace/i })).toHaveCount(0);
});
