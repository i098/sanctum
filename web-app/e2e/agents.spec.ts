import { expect, type Page, test } from '@playwright/test';

interface Credential {
  credential_id: string;
  agent_id: string;
  display_name: string;
  scopes: string[];
  meeting_ids: null;
  created_at: string;
  expires_at: null;
  revoked_at: string | null;
  last_used_at: null;
}

/** In-page stand-in for the v1 agents routes; records every write the dialog sends. */
async function agentsApi(page: Page, options: { failCreate?: boolean } = {}) {
  const credentials: Credential[] = [];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route('**/api/v1/agents**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ json: { items: credentials, next_cursor: null } });
    writes.push({ method: request.method(), path, body: request.postDataJSON() });
    if (request.method() === 'POST') {
      if (options.failCreate) return route.fulfill({ status: 403, json: { code: 'forbidden', message: 'Requires workspace:admin', retryable: false } });
      const body = request.postDataJSON();
      const credential = { credential_id: `c${credentials.length + 1}`, agent_id: `a${credentials.length + 1}`, ...body, created_at: '2026-09-29T00:00:00Z', revoked_at: null, last_used_at: null };
      credentials.push(credential);
      return route.fulfill({ status: 201, json: { credential, token: 'agent_secret_once' } });
    }
    const credential = credentials.find(c => path.endsWith(`/credentials/${c.credential_id}`))!;
    credential.revoked_at = '2026-09-29T00:05:00Z';
    return route.fulfill({ json: credential });
  });
  return { credentials, writes };
}

test('creates a scoped agent, shows its token once, and revokes it', async ({ page }) => {
  const api = await agentsApi(page);
  await page.goto('/e2e/harness/agents.html');
  await page.getByRole('button', { name: 'Agents' }).click();
  const dialog = page.getByRole('dialog', { name: 'Agents' });
  await expect(dialog.getByText('No agents yet.')).toBeVisible();

  await dialog.getByLabel('Agent name').fill('Research bot');
  await dialog.getByLabel('Add context').check();
  await dialog.getByRole('button', { name: 'Create agent' }).click();
  await expect(dialog.getByLabel('New agent token')).toHaveText('agent_secret_once');
  await expect(dialog.getByRole('list', { name: 'Agent credentials' })).toContainText('context:read, context:write');
  expect(api.writes[0]).toEqual({
    method: 'POST',
    path: '/api/v1/agents',
    body: { display_name: 'Research bot', scopes: ['context:read', 'context:write'], meeting_ids: null, expires_at: null },
  });

  page.once('dialog', confirm => confirm.accept());
  await dialog.getByRole('button', { name: 'Revoke' }).click();
  await expect(dialog.getByRole('list', { name: 'Agent credentials' })).toContainText('Revoked 2026-09-29T00:05:00Z');
  expect(api.writes[1]).toMatchObject({ method: 'DELETE', path: '/api/v1/agents/a1/credentials/c1' });

  // Closing and reopening never shows the token again.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Agents' })).toBeFocused();
  await page.getByRole('button', { name: 'Agents' }).click();
  await expect(dialog.getByLabel('New agent token')).toHaveCount(0);
});

test('shows a refused create as an error and keeps the list unchanged', async ({ page }) => {
  await agentsApi(page, { failCreate: true });
  await page.goto('/e2e/harness/agents.html');
  await page.getByRole('button', { name: 'Agents' }).click();
  const dialog = page.getByRole('dialog', { name: 'Agents' });
  await dialog.getByLabel('Agent name').fill('Denied');
  await dialog.getByRole('button', { name: 'Create agent' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Requires workspace:admin');
  await expect(dialog.getByText('No agents yet.')).toBeVisible();
});
