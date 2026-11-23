import { expect, type Page, test } from '@playwright/test';
import { type ListenOptions, serveListening } from './listen-fake.ts';
import { openMenu } from './menu.ts';

test.use({ locale: 'en-US', timezoneId: 'UTC' });

const ACCESS = {
  workspace_id: '00000000-0000-4000-8000-000000000001',
  principal: { id: '00000000-0000-4000-8000-000000000002', kind: 'human', display_name: 'Ada Lovelace' },
  role: 'member',
  scopes: ['context:read', 'context:write', 'capture:ingest'],
  meetings: { kind: 'accessible' },
  permission_revision: 1,
};
const CODE = '12345678';
const CAPABILITIES = { mic: true, screen: false, light: 'mono', speaker: false };
const CSRF = 'csrf-pair';

const device = (n: number, status: string, last_used_at: string | null) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  name: n === 1 ? 'Kitchen Pi' : 'Desk lamp',
  capabilities: CAPABILITIES,
  status,
  approved_by: ACCESS.principal,
  created_at: '2026-11-23T09:00:00.000Z',
  approved_at: '2026-11-23T09:01:00.000Z',
  last_used_at,
  revoked_at: null,
});

/**
 * Routed stand-in for `DevicesApi` (stand-in until the S1 server merges): one pending device under
 * CODE, and the server's lockout, where the sixth wrong code in a row answers 403.
 */
async function devicesApi(page: Page) {
  const state = { wrong: 0, answers: [] as unknown[], devices: [device(1, 'approved', '2026-11-23T10:15:00.000Z'), device(2, 'approved', null)] };
  await page.context().addCookies([{ name: 'sanctum_csrf', value: CSRF, url: test.info().project.use.baseURL! }]);
  const refuse = (tag: string, status: number) => ({ status, json: { _tag: tag, code: tag === 'NotFound' ? 'not_found' : 'forbidden', message: tag, retryable: false } });
  const lookUp = (code: string) => {
    if (code.replace('-', '') === CODE) return null;
    state.wrong += 1;
    return state.wrong > 5 ? refuse('Forbidden', 403) : refuse('NotFound', 404);
  };
  await page.route('**/api/v1/device/pending?*', route => {
    const refusal = lookUp(new URL(route.request().url()).searchParams.get('user_code')!);
    return route.fulfill(refusal ?? { json: { name: 'Kitchen Pi', capabilities: CAPABILITIES, expires_at: '2026-11-23T10:10:00.000Z' } });
  });
  await page.route('**/api/v1/device/approve', route => {
    expect(route.request().headers()['x-csrf-token']).toBe(CSRF);
    const body = route.request().postDataJSON();
    state.answers.push(body);
    return route.fulfill(lookUp(body.user_code) ?? { json: device(1, body.approve ? 'approved' : 'denied', null) });
  });
  await page.route('**/api/v1/devices**', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { items: state.devices } });
    const target = state.devices.find(d => route.request().url().endsWith(d.id))!;
    Object.assign(target, { status: 'revoked', revoked_at: '2026-11-23T10:20:00.000Z' });
    return route.fulfill({ status: 204 });
  });
  return state;
}

async function signedIn(page: Page, code = '') {
  await serveListening(page, { configured: true, access: ACCESS });
  const api = await devicesApi(page);
  await page.goto(`/pair${code}`);
  return api;
}

test('a signed-out visitor signs in and comes back with the code kept', async ({ page }) => {
  const options: ListenOptions = { configured: true, access: null };
  await serveListening(page, options);
  await devicesApi(page);
  await page.route('**/auth/login?*', route => {
    options.access = ACCESS;
    return route.fulfill({ status: 302, headers: { location: new URL(route.request().url()).searchParams.get('return_to')! } });
  });
  await page.goto(`/pair?code=${CODE}`);
  await page.getByRole('link', { name: 'Sign in to pair' }).click();
  await expect(page).toHaveURL(`/pair?code=${CODE}`);
  await expect(page.getByLabel('Code on the device')).toHaveValue('1234-5678');
});

test('shows the device before approval and approves it', async ({ page }) => {
  const api = await signedIn(page, `?code=${CODE}`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Kitchen Pi')).toBeVisible();
  await expect(page.getByRole('list', { name: 'What it has' })).toHaveText('MicrophoneLight');
  await expect(page.getByText('It records the room while its light is steady or its screen shows listening.')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { name: 'Paired' })).toBeVisible();
  expect(api.answers).toEqual([{ user_code: CODE, approve: true }]);
});

test('deny leaves the device not paired', async ({ page }) => {
  const api = await signedIn(page);
  await page.getByLabel('Code on the device').fill('1234 5678');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByRole('heading', { name: 'Not paired' })).toBeVisible();
  expect(api.answers).toEqual([{ user_code: CODE, approve: false }]);
});

test('a wrong code shows one inline error, and the lockout shows the lock message', async ({ page }) => {
  await signedIn(page);
  const input = page.getByLabel('Code on the device');
  for (let attempt = 1; attempt <= 5; attempt++) {
    await input.fill(`0000-000${attempt}`);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toHaveText('No device is waiting for this code. Check the code on the device.');
  }
  await input.fill('0000-0009');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toHaveText('Too many wrong codes. Wait 10 minutes, then try again.');
});

test('fits a phone with no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signedIn(page, `?code=${CODE}`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Settings lists each device, and Remove asks once and revokes it', async ({ page }) => {
  await serveListening(page, { configured: true, access: ACCESS });
  await devicesApi(page);
  await page.goto('/');
  const devices = (await openMenu(page, 'Settings')).getByRole('region', { name: 'Devices' });
  const kitchen = devices.locator('.listen-settings > div').filter({ hasText: 'Kitchen Pi' });
  await expect(kitchen).toContainText(/approved · last used Nov 23, 2026/);
  await expect(devices.locator('.listen-settings > div').filter({ hasText: 'Desk lamp' })).toContainText('approved · never used');
  page.once('dialog', confirm => confirm.accept());
  await kitchen.getByRole('button', { name: 'Remove' }).click();
  await expect(kitchen).toContainText('revoked');
  await expect(kitchen.getByRole('button', { name: 'Remove' })).toHaveCount(0);
});
