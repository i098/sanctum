import { expect, type Page, test } from '@playwright/test';
import { openListening } from './listen-fake.ts';
import { openMenu, menuSection } from './menu.ts';

const ACCESS = {
  workspace_id: '00000000-0000-4000-8000-000000000001',
  principal: { id: '00000000-0000-4000-8000-000000000002', kind: 'human', display_name: 'Ada Lovelace' },
  role: 'owner',
  scopes: ['context:read', 'actions:request'],
  meetings: { kind: 'accessible' },
  permission_revision: 1,
};
const GMAIL = { id: '00000000-0000-4000-8000-0000000000a1', app: 'gmail', grants: [{ id: '00000000-0000-4000-8000-0000000000b1', action_key: 'gmail-send-email', grantee_name: null }] };
const CALENDAR = { id: '00000000-0000-4000-8000-0000000000a2', app: 'google_calendar', grants: [] };

const apps = async (page: Page) => {
  await openListening(page, { configured: true, access: ACCESS });
  await openMenu(page, 'Apps');
  return menuSection(page, 'Apps');
};

test('Apps shows not configured, nothing connected, and each connected app with its grants', async ({ page }) => {
  let body: object = { configured: false, accounts: [] };
  await page.route(/\/api\/v1\/integrations\/accounts(\/sync)?$/, route => route.fulfill({ json: body }));
  const section = await apps(page);
  await expect(section).toHaveText('Not configured: this server has no Pipedream settings');
  await page.getByRole('button', { name: 'Close' }).click();

  body = { configured: true, accounts: [] };
  await openMenu(page, 'Apps');
  await expect(section).toContainText('No apps connected');
  await expect(section.getByRole('button', { name: 'Connect an app' })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Connect Notion' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  body = { configured: true, accounts: [GMAIL, CALENDAR] };
  await openMenu(page, 'Apps');
  const connected = section.getByRole('list').first().getByRole('listitem');
  await expect(connected).toHaveText(['GmailSend email · membersDisconnect', 'Google CalendarNo grants yetDisconnect']);
  await expect(section.getByRole('button', { name: 'Connect Gmail', exact: true })).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Connect Slack' })).toBeVisible();
});

test('Settings no longer holds Integrations', async ({ page }) => {
  await openListening(page, { configured: true, access: ACCESS });
  await expect(await openMenu(page, 'Settings')).not.toContainText('Integrations');
});

test('Connect opens the Connect Link in a new tab, keeps this tab capturing, and stores the account on return; Disconnect removes it', async ({ page, context }) => {
  await context.addCookies([{ name: 'sanctum_csrf', value: 'csrf-fixture', url: 'http://localhost' }]);
  let accounts: Array<object> = [];
  const writes: Array<{ path: string; body: unknown; csrf: string | undefined }> = [];
  await page.route('**/api/v1/integrations/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1/integrations', '');
    if (request.method() === 'POST') writes.push({ path, body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] });
    if (path === '/connect') return route.fulfill({ json: { url: `${new URL(request.url()).origin}/connect-link-fixture?app=gmail` } });
    if (path.endsWith('/disconnect')) accounts = [];
    return route.fulfill({ json: { configured: true, accounts } });
  });
  await context.route('**/connect-link-fixture?*', route => route.fulfill({ contentType: 'text/html', body: '<title>Connect Link</title>' }));
  const section = await apps(page);
  await expect(section).toContainText('No apps connected');

  await section.getByRole('textbox', { name: 'App to connect' }).fill('gmail');
  const [tab] = await Promise.all([context.waitForEvent('page'), section.getByRole('button', { name: 'Connect an app' }).click()]);
  await expect(tab).toHaveURL(/\/connect-link-fixture\?app=gmail$/);
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await expect(section).toContainText('Finish in the Pipedream tab.');
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);

  accounts = [GMAIL];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(section.getByRole('listitem').filter({ hasText: 'Disconnect' })).toHaveText(['GmailSend email · membersDisconnect']);

  await section.getByRole('button', { name: 'Disconnect Gmail' }).click();
  await expect(section.getByRole('button', { name: 'Disconnect Gmail' })).toHaveCount(0);
  const [tileTab] = await Promise.all([context.waitForEvent('page'), section.getByRole('button', { name: 'Connect Notion' }).click()]);
  await expect(tileTab).toHaveURL(/\/connect-link-fixture\?app=gmail$/);
  // Dev StrictMode runs Settings' effects twice, so only the non-sync writes are compared exactly.
  expect(writes.every(write => write.csrf === 'csrf-fixture')).toBe(true);
  expect(writes.filter(write => write.path !== '/accounts/sync')).toEqual([
    { path: '/connect', body: { app: 'gmail' }, csrf: 'csrf-fixture' },
    { path: `/accounts/${GMAIL.id}/disconnect`, body: null, csrf: 'csrf-fixture' },
    { path: '/connect', body: { app: 'notion' }, csrf: 'csrf-fixture' },
  ]);
});
