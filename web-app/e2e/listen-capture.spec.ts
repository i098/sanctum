/** Integration: the listening page drives the real capture engine (no test-side engine). */
import { expect, test } from '@playwright/test';
import { fakeServer } from './capture-server.ts';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test('page controls start the real engine, overlays leave capture running, pause stops it', async ({ page }) => {
  const server = await fakeServer(page);
  await page.goto('/');
  const state = page.locator('.listen-state');
  await expect(state).toHaveText('stopped');

  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(state).toHaveText('listening', { timeout: 15_000 });
  await expect.poll(() => server.starts.length).toBe(1);
  await expect.poll(() => server.frames, { timeout: 10_000 }).toBeGreaterThan(5);

  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByRole('dialog', { name: 'Review' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const framesAfterOverlay = server.frames;
  await expect.poll(() => server.frames, { timeout: 10_000 }).toBeGreaterThan(framesAfterOverlay);
  await expect(state).toHaveText('listening');
  expect(server.starts).toHaveLength(1);

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(state).toHaveText('paused', { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
});

test('names lost live transcription while the audio keeps streaming', async ({ page }) => {
  const server = await fakeServer(page, false, 'provider_unavailable');
  await page.goto('/');
  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(page.locator('.listen-state')).toHaveText('degraded', { timeout: 15_000 });
  await expect(page.locator('.listen-helper[data-warning="true"]')).toContainText('transcription');
  const frames = server.frames;
  await expect.poll(() => server.frames, { timeout: 10_000 }).toBeGreaterThan(frames);
});

test('End meeting keeps through a pause, then stops capture and closes the meeting with the CSRF header', async ({ page }) => {
  await fakeServer(page);
  const id = '5b0c2d4e-6f70-4a81-92b3-c4d5e6f7a8b9';
  const events: string[] = [];
  const epochs: unknown[] = [];
  let open = true;
  let reads = 0;
  // Replaces the fake media socket: each accepted stream names the listener's open meeting first, as the server's feed does.
  await page.routeWebSocket(/\/api\/v1\/listeners\/[^/]+\/stream$/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== 'string') return;
      const control = JSON.parse(message) as Record<string, unknown>;
      if (control['_tag'] === 'stop') return void events.push(`stop:${String(control['reason'])}`);
      epochs.push(control['epoch_id']);
      ws.send(JSON.stringify({ _tag: 'accepted', epoch_id: control['epoch_id'], resume_from_sample: 0, max_frame_bytes: 19_224 }));
      ws.send(JSON.stringify({ _tag: 'action_update', meeting_id: open ? id : null, actions: [] }));
    });
  });
  const processing = { transcript: 'pending', notes: 'pending', memory: 'pending', recording: 'pending' };
  const meeting = () => ({ id, workspace_id: id, state: open ? 'active' : 'closing', title: null, started_at: '2026-09-28T10:02:00.000Z', ended_at: null, timezone: 'UTC', boundary_revision: 1, visibility: 'restricted', processing });
  await page.route(`**/api/v1/meetings/${id}`, route => (reads++, route.fulfill({ json: meeting() })));
  await page.route(`**/api/v1/meetings/${id}/end`, (route) => {
    const fence = route.request().postDataJSON() as Record<string, unknown>;
    events.push(`end:${route.request().headers()['x-csrf-token']}:${fence['epoch_id'] === epochs.at(-1)}:${typeof fence['fence_sample']}`);
    open = false;
    return route.fulfill({ json: meeting() });
  });

  await page.goto('/');
  const state = page.locator('.listen-state');
  const end = page.getByRole('button', { name: 'End meeting' });
  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(end).toBeVisible({ timeout: 15_000 });
  // Pause ends the stream with an update naming no meeting; the server still reports the meeting open, so the control stays.
  const before = reads;
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(state).toHaveText('paused', { timeout: 15_000 });
  await expect.poll(() => reads).toBe(before + 1);
  await expect(end).toBeVisible();

  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(state).toHaveText('listening', { timeout: 15_000 });
  await end.click();
  await page.getByRole('dialog', { name: 'End this meeting?' }).getByRole('button', { name: 'End meeting' }).click();
  await expect(page.locator('.listen-helper')).toHaveText('Meeting ended. Its notes are being prepared in Review.');
  await expect(state).toHaveText('paused');
  await expect(end).toHaveCount(0);
  // Capture stopped before the close, so the server placed the last speech first.
  expect(events).toEqual(['stop:pause', 'stop:pause', 'end:csrf-e2e-token:true:number']);
});

test('End meeting shows after a reload while no stream is open, for the meeting of this browser\'s listener only', async ({ page }) => {
  const server = await fakeServer(page);
  const id = '5b0c2d4e-6f70-4a81-92b3-c4d5e6f7a8b9';
  const listener = '7c1d3e5f-8091-4a2b-93c4-d5e6f7a8b9c0';
  await page.addInitScript(stored => localStorage.setItem('sanctum.listener', stored), JSON.stringify({ id: listener, lease_generation: 1 }));
  const processing = { transcript: 'pending', notes: 'pending', memory: 'pending', recording: 'pending' };
  const meeting = (state: string) => ({ id, workspace_id: id, state, title: null, started_at: '2026-09-28T10:02:00.000Z', ended_at: null, timezone: 'UTC', boundary_revision: 1, visibility: 'restricted', processing });
  const asked: string[] = [];
  await page.route('**/api/v1/meetings?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    asked.push(`${query.get('state')}:${query.get('listener')}`);
    return route.fulfill({ json: { meetings: query.get('state') === 'active' && query.get('listener') === listener ? [meeting('active')] : [], next_cursor: null } });
  });
  const closes: string[] = [];
  await page.route(`**/api/v1/meetings/${id}/close`, (route) => {
    closes.push(route.request().headers()['x-csrf-token']!);
    return route.fulfill({ json: meeting('closing') });
  });

  await page.goto('/');
  await expect(page.locator('.listen-state')).toHaveText('stopped');
  const end = page.getByRole('button', { name: 'End meeting' });
  await expect(end).toBeVisible();
  expect([...new Set(asked)].sort()).toEqual([`active:${listener}`, `provisional:${listener}`]);
  await end.click();
  await page.getByRole('dialog', { name: 'End this meeting?' }).getByRole('button', { name: 'End meeting' }).click();
  await expect(end).toHaveCount(0);
  expect(closes).toEqual(['csrf-e2e-token']);
  expect(server.starts).toHaveLength(0);
});

test('no End meeting control on load when this browser has no listener', async ({ page }) => {
  await fakeServer(page);
  let asked = 0;
  await page.route('**/api/v1/meetings?*', route => (asked++, route.fulfill({ json: { meetings: [], next_cursor: null } })));
  await page.goto('/');
  await expect(page.locator('.listen-state')).toHaveText('stopped');
  await expect(page.getByRole('button', { name: 'End meeting' })).toHaveCount(0);
  expect(asked).toBe(0);
});
