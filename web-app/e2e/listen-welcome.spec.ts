import { expect, test, type Page } from '@playwright/test';
import { fakeWorkosWidgets, serveListening, type ListenOptions } from './listen-fake.ts';

// Chromium's synthetic microphone (it beeps) with its permission prompt auto-accepted, for the microphone step.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

const OWNER = {
  workspace_id: '00000000-0000-4000-8000-000000000001',
  principal: { id: '00000000-0000-4000-8000-000000000002', kind: 'human', display_name: 'Ada Lovelace' },
  role: 'owner',
  scopes: ['context:read', 'context:write', 'recordings:read', 'actions:request', 'actions:execute', 'workspace:admin'],
  meetings: { kind: 'accessible' },
  permission_revision: 1,
};
const MEMBER = { ...OWNER, role: 'member', scopes: OWNER.scopes.filter(scope => scope !== 'workspace:admin') };

/** Signed in on the hosted shape (WorkOS) as someone who has not seen the welcome yet. */
const firstVisit = (overrides: ListenOptions = {}): ListenOptions => ({ configured: true, workos: true, access: OWNER, onboarding: { completed: false, workspace_name: 'Acme' }, ...overrides });

async function openWelcome(page: Page, options: ListenOptions) {
  await serveListening(page, options);
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Sanctum' });
  await expect(welcome).toBeVisible();
  return welcome;
}

test('a new signed-in person sees the welcome; Skip marks it done and it does not open again', async ({ page }) => {
  const options = firstVisit();
  const welcome = await openWelcome(page, options);
  await expect(welcome).toContainText('Step 1 of 4');
  await expect(welcome.getByRole('heading', { name: 'What Sanctum records' })).toBeVisible();
  await expect(welcome).toContainText('Audio, only while this tab is open and listening');

  await welcome.getByRole('button', { name: 'Skip' }).click();
  await expect(welcome).toBeHidden();
  await expect.poll(() => options.onboarding!.completed).toBe(true);
  expect(await page.evaluate(() => window.__capture.calls)).toEqual([]);

  const read = page.waitForResponse('**/api/v1/onboarding');
  await page.reload();
  await read;
  await expect(page.getByText('stopped', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Welcome to Sanctum' })).toBeHidden();
});

test('finishing walks every step by keyboard, renames the workspace, and Start listening starts capture', async ({ page }) => {
  const options = firstVisit();
  const welcome = await openWelcome(page, options);
  const next = welcome.getByRole('button', { name: 'Next' });

  await next.click();
  await expect(welcome.getByRole('heading', { name: 'Check your microphone' })).toBeFocused();
  await welcome.getByRole('button', { name: 'Back' }).click();
  await expect(welcome.getByRole('heading', { name: 'What Sanctum records' })).toBeFocused();
  await next.click();
  await next.click();

  await expect(welcome.getByRole('heading', { name: 'Your workspace' })).toBeFocused();
  const name = welcome.getByRole('textbox', { name: 'Workspace name' });
  await expect(name).toHaveValue('Acme');
  await name.fill('  Acme Labs ');
  await name.press('Enter');
  await expect(welcome.getByRole('heading', { name: 'Ready to listen' })).toBeFocused();
  expect(options.onboarding).toEqual({ completed: false, workspace_name: 'Acme Labs' });

  await welcome.getByRole('button', { name: 'Start listening' }).press('Enter');
  await expect(welcome).toBeHidden();
  await expect(page.getByText('listening', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__capture.calls)).toEqual(['start']);
  await expect.poll(() => options.onboarding!.completed).toBe(true);
});

test('Settings opens the welcome again after it was done', async ({ page }) => {
  await serveListening(page, firstVisit({ onboarding: { completed: true, workspace_name: 'Acme' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Show welcome again' }).click();
  const welcome = page.getByRole('dialog', { name: 'Welcome to Sanctum' });
  await expect(welcome).toBeVisible();
  await expect(settings).toBeHidden();
  await expect(welcome).toContainText('Step 1 of 4');
  await page.keyboard.press('Escape');
  await expect(welcome).toBeHidden();
});

test('the workspace step offers the hosted Team: Invite teammates when linked, Set up team for an unlinked owner', async ({ page }) => {
  const options = firstVisit();
  await fakeWorkosWidgets(page);
  const welcome = await openWelcome(page, options);
  for (let step = 0; step < 2; step++) await welcome.getByRole('button', { name: 'Next' }).click();
  await welcome.getByRole('button', { name: 'Invite teammates' }).click();
  const team = page.getByRole('dialog', { name: 'Team' });
  await expect(team.getByRole('region', { name: 'Members' })).toContainText('grace@example.test');
  await team.getByRole('button', { name: 'Close' }).click();
  await expect(team).toBeHidden();
  await expect(welcome.getByRole('heading', { name: 'Your workspace' })).toBeVisible();

  options.teamLinked = false;
  await page.reload();
  for (let step = 0; step < 2; step++) await welcome.getByRole('button', { name: 'Next' }).click();
  await expect(welcome.getByRole('button', { name: 'Set up team' })).toBeVisible();
});

test('a member reads the workspace name and gets no rename or invite', async ({ page }) => {
  const welcome = await openWelcome(page, firstVisit({ access: MEMBER }));
  for (let step = 0; step < 2; step++) await welcome.getByRole('button', { name: 'Next' }).click();
  await expect(welcome).toContainText('You are in Acme. Its owners and admins rename it and invite people.');
  await expect(welcome.getByRole('textbox')).toHaveCount(0);
  await expect(welcome.getByRole('button', { name: 'Invite teammates' })).toHaveCount(0);
});

test('the microphone step asks for the microphone, then shows the picker and a level meter that moves with the input', async ({ page }) => {
  const welcome = await openWelcome(page, firstVisit());
  await welcome.getByRole('button', { name: 'Next' }).click();
  const meter = welcome.getByRole('meter', { name: 'Microphone level' });
  await expect(meter).toHaveAttribute('aria-valuenow', '0');
  await expect(welcome.getByRole('combobox', { name: 'Microphone' })).toHaveCount(0);
  await welcome.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(welcome.getByRole('combobox', { name: 'Microphone' })).toBeVisible();
  // The synthetic input beeps: the meter rises with each beep and falls between them.
  const seen = new Set<number>();
  await expect.poll(async () => {
    seen.add(Number(await meter.getAttribute('aria-valuenow')));
    return Math.max(...seen) > 30 && seen.size > 3;
  }, { timeout: 10_000, intervals: [50] }).toBe(true);
  await expect(welcome).toContainText('This input is sending sound.');
  expect(await page.evaluate(() => window.__capture.calls)).toEqual([]);
});
