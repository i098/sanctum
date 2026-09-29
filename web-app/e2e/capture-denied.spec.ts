import { expect, test } from '@playwright/test';
import { capture, fakeServer, snapshot } from './capture-server.ts';

// Chromium's synthetic microphone with its permission prompt auto-denied.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream=deny'] } });

test('reports a real browser denial', async ({ page }) => {
  await fakeServer(page);
  await capture(page, { start: true, chunkSeconds: 30 });
  expect(await snapshot(page)).toMatchObject({ listener: 'stopped', permission: 'denied', issue: 'permission_denied', archive: null });
});
