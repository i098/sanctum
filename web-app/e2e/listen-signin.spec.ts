import { expect, test, type Locator, type Page } from '@playwright/test';
import { openListening, serveListening, type FakeSignIn } from './listen-fake.ts';

const ACCESS = {
  workspace_id: '00000000-0000-4000-8000-000000000001',
  principal: { id: '00000000-0000-4000-8000-000000000002', kind: 'human', display_name: 'Ada Lovelace' },
  role: 'owner',
  scopes: ['context:read', 'context:write'],
  meetings: { kind: 'accessible' },
  permission_revision: 1,
};

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  return settings;
}

const row = (settings: Locator, term: string) =>
  settings.locator('.listen-settings div').filter({ has: settings.page().getByRole('term').filter({ hasText: term }) }).getByRole('definition');

test('not configured: no sign-in path is offered', async ({ page }) => {
  await openListening(page, { configured: false, access: null });
  await expect(page.locator('.listen-helper')).toHaveText('Speak to Sanctum when you need it.');
  const settings = await openSettings(page);
  await expect(row(settings, 'Sign-in')).toHaveText('Not configured: no sign-in provider has been selected');
  await expect(row(settings, 'Workspace')).toHaveText('Unavailable until sign-in is configured');
  await expect(page.getByRole('link')).toHaveCount(0);
});

test('a failing /auth/config reads as unavailable, not as not configured', async ({ page }) => {
  await openListening(page, { configured: 'unavailable', access: null });
  const settings = await openSettings(page);
  await expect(row(settings, 'Sign-in')).toHaveText('Unavailable: the session could not be read');
});

test('signed out: the page and Settings link to sign-in', async ({ page }) => {
  await openListening(page, { configured: true, access: null });
  await expect(page.getByRole('link', { name: 'Sign in to listen' })).toHaveAttribute('href', '/auth/login?return_to=/');
  const settings = await openSettings(page);
  await expect(row(settings, 'Sign-in')).toHaveText('Signed outSign in');
  await expect(settings.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/login?return_to=/');
  await expect(row(settings, 'Workspace')).toHaveText('Unavailable until you sign in');
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`signed out at ${viewport.width}x${viewport.height}: the side rails never cover Sign in to listen`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openListening(page, { configured: true, access: null });
    const link = page.getByRole('link', { name: 'Sign in to listen' });
    await expect(link).toBeVisible();
    const box = (await link.boundingBox())!;
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.textContent, [box.x + box.width / 2, box.y + box.height / 2]);
    expect(hit).toBe('Sign in to listen');
    await link.click({ trial: true });
  });
}

test('signed in: name, role, keyboard focus, sign out', async ({ page, context }) => {
  const signIn: FakeSignIn = { configured: true, access: ACCESS };
  await context.addCookies([{ name: 'sanctum_csrf', value: 'csrf-fixture', url: 'http://localhost' }]);
  let csrf: string | null = null;
  await page.route('**/auth/logout', route => {
    csrf = route.request().headers()['x-csrf-token'] ?? null;
    signIn.access = null;
    return route.fulfill({ status: 204 });
  });
  await openListening(page, signIn);
  await expect(page.locator('.listen-helper')).toHaveText('Speak to Sanctum when you need it.');
  const settings = await openSettings(page);
  await expect(row(settings, 'Sign-in')).toContainText('Signed in as Ada Lovelace (owner)');

  // Tab reaches each sign-in control and stays inside the dialog.
  const reached = new Set<string>();
  for (let press = 0; press < 6; press++) {
    await page.keyboard.press('Tab');
    expect(await settings.evaluate(element => element.contains(document.activeElement))).toBe(true);
    reached.add(await page.evaluate(() => document.activeElement?.textContent ?? ''));
  }
  expect(reached).toEqual(new Set(['Close', 'Connect sign-in', 'Sign out']));

  await settings.getByRole('button', { name: 'Sign out' }).press('Enter');
  await expect(row(settings, 'Sign-in')).toHaveText('Signed outSign in');
  expect(csrf).toBe('csrf-fixture');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: 'Sign in to listen' })).toBeVisible();
});

test('a failed sign out says the session is still open', async ({ page }) => {
  await page.route('**/auth/logout', route => route.fulfill({ status: 503 }));
  await openListening(page, { configured: true, access: ACCESS });
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Sign out' }).click();
  await expect(settings.getByRole('alert')).toHaveText('Sign out did not finish; you are still signed in.');
  await expect(row(settings, 'Sign-in')).toContainText('Signed in as Ada Lovelace (owner)');
});

test('Connect sign-in navigates to the issuer URL the server returns', async ({ page }) => {
  await page.route('**/auth/link', route => route.fulfill({ json: { url: '/fixture-issuer/authorize?state=s' } }));
  await page.route('**/fixture-issuer/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Issuer</title>' }));
  await openListening(page, { configured: true, access: ACCESS });
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Connect sign-in' }).click();
  await expect(page).toHaveURL(/\/fixture-issuer\/authorize\?state=s$/);
});

test('a login-link session without an issuer offers no sign out', async ({ page }) => {
  await openListening(page, { configured: false, access: ACCESS });
  const settings = await openSettings(page);
  await expect(row(settings, 'Sign-in')).toHaveText('Signed in as Ada Lovelace (owner)');
  await expect(settings.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});

test('not a member: Settings opens with the issuer and subject for the operator', async ({ page }) => {
  await serveListening(page, { configured: true, access: null });
  await page.goto('/?signin=not_member&issuer=https%3A%2F%2Fexample.authkit.app&subject=user_01FIXTURE');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('status')).toContainText('not a member of a workspace');
  await expect(settings.getByRole('status').getByRole('definition')).toHaveText(['https://example.authkit.app', 'user_01FIXTURE']);
  await expect(page).toHaveURL(/\/$/);
});

test('a failed sign-in callback says so', async ({ page }) => {
  await serveListening(page, { configured: true, access: null });
  await page.goto('/?signin=failed');
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('status')).toHaveText('Sign-in did not finish. Try again.');
});
