import { expect, type Page, test } from '@playwright/test';
import { openListening } from './listen-fake.ts';

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

const integrations = async (page: Page) => {
  await openListening(page, { configured: true, access: ACCESS });
  await page.getByRole('button', { name: 'Settings' }).click();
  return page.getByRole('dialog', { name: 'Settings' }).locator('.listen-settings > div').filter({ has: page.getByRole('term').getByText('Integrations', { exact: true }) });
};

test('Integrations shows not configured, nothing connected, and each connected app with its grants', async ({ page }) => {
  let body: object = { configured: false, accounts: [] };
  await page.route(/\/api\/v1\/integrations\/accounts(\/sync)?$/, route => route.fulfill({ json: body }));
  const row = await integrations(page);
  await expect(row.getByRole('definition')).toHaveText('Not configured: this server has no Pipedream settings');
  await page.getByRole('button', { name: 'Close' }).click();

  body = { configured: true, accounts: [] };
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(row.getByRole('definition')).toContainText('No apps connected');
  await expect(row.getByRole('button', { name: 'Connect an app' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  body = { configured: true, accounts: [GMAIL, CALENDAR] };
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(row.getByRole('listitem')).toHaveText(['Gmailgmail-send-email for a memberDisconnect', 'Google CalendarNo grants yetDisconnect']);
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
  const row = await integrations(page);
  await expect(row.getByRole('definition')).toContainText('No apps connected');

  await row.getByRole('combobox', { name: 'App to connect' }).fill('gmail');
  const [tab] = await Promise.all([context.waitForEvent('page'), row.getByRole('button', { name: 'Connect an app' }).click()]);
  await expect(tab).toHaveURL(/\/connect-link-fixture\?app=gmail$/);
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await expect(row).toContainText('Finish in the Pipedream tab.');
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);

  accounts = [GMAIL];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(row.getByRole('listitem')).toHaveText(['Gmailgmail-send-email for a memberDisconnect']);

  await row.getByRole('button', { name: 'Disconnect Gmail' }).click();
  await expect(row.getByRole('listitem')).toHaveCount(0);
  // Dev StrictMode runs Settings' effects twice, so only the non-sync writes are compared exactly.
  expect(writes.every(write => write.csrf === 'csrf-fixture')).toBe(true);
  expect(writes.filter(write => write.path !== '/accounts/sync')).toEqual([
    { path: '/connect', body: { app: 'gmail' }, csrf: 'csrf-fixture' },
    { path: `/accounts/${GMAIL.id}/disconnect`, body: null, csrf: 'csrf-fixture' },
  ]);
});
