import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { fakeWorkosWidgets, openListening, openMeeting, serveListening } from './listen-fake.ts';
import { openMenu } from './menu.ts';

// Chromium's synthetic microphone, so the welcome's microphone step has an input to show.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, locale: 'en-US', timezoneId: 'UTC' });

const OWNER = {
  workspace_id: '00000000-0000-4000-8000-000000000001',
  principal: { id: '00000000-0000-4000-8000-000000000002', kind: 'human', display_name: 'Ada Lovelace' },
  role: 'owner',
  scopes: ['context:read', 'context:write', 'recordings:read', 'actions:request', 'actions:execute', 'workspace:admin'],
  meetings: { kind: 'accessible' },
  permission_revision: 1,
};
const MEETING = '5f0c6f7e-8d1b-4c2a-9e3f-1a2b3c4d5e6f';
const WORKSPACE = { id: '11111111-1111-4111-8111-111111111111', name: 'Acme Studio', deleted_at: null, purge_after: null };

/** Every visible button, the WorkOS widgets' too (a dropdown is not a button here), and primary link that wears the old look: all caps, monospace, or an outline over (almost) no fill (a border or a ring shadow; a tab's underline is not one). */
const outdated = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    // Half-see-through still reads as an outline over no fill.
    const transparent = (color: string) => Number(/^rgba\(.*, ([\d.]+)\)$/.exec(color)?.[1] ?? (color === 'transparent' ? 0 : 1)) <= 0.5;
    return [...document.querySelectorAll<HTMLElement>('button, a[data-primary]')]
      .filter(element => element.getClientRects().length > 0 && element.getAttribute('role') !== 'combobox')
      .flatMap(element => {
        const style = getComputedStyle(element);
        const ring = ['Top', 'Right', 'Bottom', 'Left'].some(side => {
          const width = style[`border${side}Width` as 'borderTopWidth'];
          return width !== '0px' && style[`border${side}Style` as 'borderTopStyle'] !== 'none' && !transparent(style[`border${side}Color` as 'borderTopColor']);
        }) || /\) 0px 0px 0px [1-9]/.test(style.boxShadow);
        const why = [
          style.textTransform === 'uppercase' && 'uppercase',
          /mono/i.test(style.fontFamily) && 'monospace',
          transparent(style.backgroundColor) && ring && 'outline without fill',
        ].filter(Boolean);
        return why.length ? [`${element.textContent?.trim() || element.getAttribute('aria-label')}: ${why.join(', ')}`] : [];
      });
  });

/** Visible text that is a tiny all-caps label: uppercase under 14px. */
const tinyCaps = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('body *')]
      .filter(element => element.getClientRects().length > 0 && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()))
      .filter(element => getComputedStyle(element).textTransform === 'uppercase' && parseFloat(getComputedStyle(element).fontSize) < 14)
      .map(element => `${element.tagName.toLowerCase()}.${element.className}: ${element.textContent?.trim().slice(0, 30)}`),
  );

/** The server's answers for every screen below; the engine and sign-in come from `serveListening`. */
async function stubApi(page: Page, context: BrowserContext): Promise<void> {
  await context.addCookies([{ name: 'sanctum_csrf', value: 'csrf-fixture', url: 'http://localhost' }]);
  await fakeWorkosWidgets(page);
  const meeting = { id: MEETING, title: 'Product sync', state: 'active', started_at: '2026-09-28T10:02:00Z', timezone: 'UTC' };
  const agent = { agent: { id: '00000000-0000-4000-8000-0000000000c1', display_name: 'Claude' }, credential: { id: '00000000-0000-4000-8000-0000000000d1', scopes: ['context:read'], revoked_at: null } };
  await page.route('**/api/v1/meetings?*', route => route.fulfill({ json: { meetings: [meeting], next_cursor: null } }));
  await page.route(/\/api\/v1\/meetings\/[^/?]+\/(notes|transcript|actions|recording|context)/, route => route.fulfill({ status: 404, json: { _tag: 'NotFound', code: 'not_found', message: 'none', retryable: false } }));
  await page.route('**/api/v1/agents**', route => route.fulfill({ json: { items: [agent], next_cursor: null } }));
  await page.route('**/api/v1/integrations/**', route => route.fulfill({ json: { configured: true, accounts: [{ id: '00000000-0000-4000-8000-0000000000a1', app: 'gmail', grants: [] }] } }));
  await page.route('**/api/v1/workspace', route => route.fulfill({ json: WORKSPACE }));
}

test('the signed-out status, every step of the welcome and the issuer\'s own pages', async ({ page, context }) => {
  await stubApi(page, context);
  const found: string[] = [];
  const look = async (screen: string) => found.push(...[...(await outdated(page)), ...(await tinyCaps(page))].map(button => `${screen} > ${button}`));

  await serveListening(page, { configured: true, access: null });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Sign in to listen' })).toBeVisible();
  await look('signed out');

  const welcome = page.getByRole('dialog', { name: 'Welcome to Sanctum' });
  await page.unroute('**/auth/config');
  await page.unroute('**/api/v1/session');
  await serveListening(page, { configured: true, workos: true, access: OWNER, onboarding: { completed: false, workspace_name: 'Acme' } });
  await page.reload();
  for (const step of [1, 2, 3, 4]) {
    await expect(welcome).toContainText(`Step ${step} of 4`);
    await look(`welcome step ${step}`);
    if (step < 4) await welcome.getByRole('button', { name: 'Next' }).click();
  }
  // The embedded issuer's own pages.
  for (const path of ['/sign-in', '/consent?client_id=agent&scope=context:read']) {
    await page.goto(path);
    await expect(page.getByRole('button').first()).toBeVisible();
    await look(path);
  }
  expect(found).toEqual([]);
});

test('the listening screen, its End meeting confirm and every Menu section', async ({ page, context }) => {
  await stubApi(page, context);
  const found: string[] = [];
  const look = async (screen: string) => found.push(...[...(await outdated(page)), ...(await tinyCaps(page))].map(button => `${screen} > ${button}`));

  await openListening(page, { configured: true, workos: true, access: OWNER });
  await openMeeting(page, MEETING, 'Product sync');
  await look('listening');
  await page.getByRole('button', { name: 'End meeting' }).click();
  await look('End meeting confirm');
  await page.getByRole('button', { name: 'Cancel' }).click();

  for (const section of ['Meetings', 'Agents', 'Apps', 'Settings']) {
    const body = await openMenu(page, section);
    await look(section);
    if (section === 'Agents') {
      await body.getByRole('tab', { name: 'Access tokens' }).click();
      await look('Agents > Access tokens');
    }
    if (section === 'Settings') {
      await body.getByRole('button', { name: 'Team' }).click();
      await expect(body.getByRole('region', { name: 'Members' })).toBeVisible();
      await look('Settings > Team');
      await body.getByRole('button', { name: 'Delete workspace…' }).click();
      await look('Delete workspace confirm');
      await page.getByRole('dialog', { name: 'Delete workspace?' }).getByRole('button', { name: 'Cancel' }).click();
    }
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('button', { name: 'Close' }).click();
  }
  expect(found).toEqual([]);
});
