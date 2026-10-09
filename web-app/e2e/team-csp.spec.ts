import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { fakeWorkosWidgets, realServer } from './listen-fake.ts';

/**
 * The hosted Team overlay on the built website behind the real server and its real CSP
 * (server/tests/support/team-server.ts): opening Team and using the widgets' selects, menu, dialog
 * and scroll area must raise no CSP violation. The widgets add three fixed `<style>` elements that
 * `style-src` allows by hash (server/src/web.ts); a dependency bump that changes one fails here.
 */
const WEB_ROOT = fileURLToPath(new URL('../dist/', import.meta.url));

test.beforeAll(() => {
  if (!existsSync(WEB_ROOT)) throw new Error('Build the website first: npm run build -w web-app');
});
const started = realServer<{ url: string; session: string; csrf: string }>(new URL('../../server/tests/support/team-server.ts', import.meta.url), WEB_ROOT);

declare global {
  interface Window {
    cspViolations: Array<string>;
    styleTexts: Array<string>;
  }
}

test('Team on the built site: the widgets render under the real CSP without a violation', async ({ page }) => {
  const server = started();
  await page.addInitScript(() => {
    window.cspViolations = [];
    window.styleTexts = [];
    document.addEventListener('securitypolicyviolation', event => window.cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`));
    // An inserted subtree reports only its root, so its descendant `<style>` elements are read too.
    new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
      if (!(node instanceof Element)) return;
      for (const style of [node, ...node.querySelectorAll('style')]) if (style instanceof HTMLStyleElement) window.styleTexts.push(style.textContent ?? '');
    }))).observe(document, { childList: true, subtree: true });
  });
  await page.context().addCookies([
    { name: 'sanctum_session', value: server.session, url: server.url, httpOnly: true },
    { name: 'sanctum_csrf', value: server.csrf, url: server.url, sameSite: 'Strict' },
  ]);
  await fakeWorkosWidgets(page);
  // The real server issues the widget token here.
  await page.unroute('**/api/v1/workspace/widget-token');
  await page.goto(server.url);
  // The seeded owner has not seen the welcome; Skip stores that with the real CSRF-checked POST.
  const welcome = page.getByRole('dialog', { name: 'Welcome to Sanctum' });
  const stored = page.waitForResponse(response => response.url().endsWith('/api/v1/onboarding') && response.request().method() === 'POST');
  await welcome.getByRole('button', { name: 'Skip' }).click();
  await expect(welcome).toBeHidden();
  expect((await stored).status()).toBe(200);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Team' }).click();
  const team = page.getByRole('dialog', { name: 'Team' });
  const members = team.getByRole('region', { name: 'Members' });
  await expect(members).toContainText('grace@example.test');
  await expect(team.getByRole('region', { name: 'Your profile' })).toContainText('Ada Lovelace');

  // The role select above the members, a member's menu, and the invite dialog with its own role select.
  await members.getByRole('combobox').click();
  await expect(page.getByRole('option', { name: 'Owner' })).toBeVisible();
  await page.keyboard.press('Escape');
  await members.getByRole('row').filter({ hasText: 'grace@example.test' }).getByRole('button').click();
  await expect(page.getByRole('menuitem', { name: 'Remove user' })).toBeVisible();
  await page.keyboard.press('Escape');
  await team.getByRole('button', { name: 'Invite user' }).click();
  const invite = team.getByRole('dialog', { name: 'Invite user' });
  await invite.getByRole('combobox').click();
  await expect(page.getByRole('option', { name: 'Admin' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(invite).toBeHidden();

  const styles = await page.evaluate(() => window.styleTexts.join('\n'));
  for (const marker of ['data-radix-scroll-area-viewport', 'data-radix-select-viewport', 'data-scroll-locked']) expect(styles).toContain(marker);
  expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
  // Radix Themes' stylesheet applied: the widgets' accent is Sanctum's blue.
  expect(await team.getByRole('button', { name: 'Invite user' }).evaluate(button => getComputedStyle(button).backgroundColor)).toBe('rgb(61, 125, 255)');
});
