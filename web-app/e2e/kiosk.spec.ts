import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { waveProfile } from './listen-fake.ts';

/** The built kiosk (npm run build -w web-app), served alone the way the device client serves it on loopback. */
const KIOSK_ROOT = fileURLToPath(new URL('../dist/kiosk/', import.meta.url));
const DEVICE = 'http://127.0.0.1:7171';
/** Idle breathing never reaches speech height; anything taller is the line reacting to bands (as in listen-waveform.spec.ts). */
const RESTING = 30;

const BASE = {
  level: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0], code: null, verification_uri: null, name: 'Room 4',
  cause: null, saved_through: null, owner: { approved_by_name: 'Ada Lovelace', workspace_name: 'Acme Studio' },
};
const STATES = {
  unpaired: { ...BASE, state: 'unpaired', code: '1234-5678', verification_uri: 'https://sanctum.42nights.dev/pair', owner: null },
  stopped: { ...BASE, state: 'stopped' },
  paused: { ...BASE, state: 'paused' },
  starting: { ...BASE, state: 'starting' },
  listening: { ...BASE, state: 'listening', saved_through: '2026-11-23T10:04:00Z' },
  reconnecting: { ...BASE, state: 'reconnecting' },
  degraded: { ...BASE, state: 'degraded', cause: 'Chunk upload is behind.' },
  error: { ...BASE, state: 'error', cause: 'No microphone found.' },
};
type Feed = Record<string, unknown> | null;

test.beforeAll(() => {
  if (!existsSync(KIOSK_ROOT)) throw new Error('Build the kiosk first: npm run build -w web-app');
});

/** Serves only the kiosk build plus `/events`; each `/events` request answers the current feed, or 503 once the feed is null. */
async function openKiosk(page: Page, first: Feed, loud = false): Promise<{ set: (feed: Feed) => void }> {
  let feed = first;
  await page.route(`${DEVICE}/**`, route => {
    const path = new URL(route.request().url()).pathname;
    if (path !== '/events') return route.fulfill({ path: `${KIOSK_ROOT}${path === '/' ? 'index.html' : path.slice(1)}` });
    if (feed === null) return route.fulfill({ status: 503 });
    // Bands that come and go, as speech does, so the waveform's noise floor never absorbs them.
    const bands = loud ? Array.from({ length: 8 }, () => (Math.random() < 0.5 ? 0.95 : 0.05)) : feed['bands'];
    return route.fulfill({ contentType: 'text/event-stream', body: `retry: 40\ndata: ${JSON.stringify({ ...feed, bands })}\n\n` });
  });
  await page.goto(`${DEVICE}/`);
  return { set: next => void (feed = next) };
}

/** Every text box lies inside the viewport, and the page scrolls in no direction. */
function fits(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const scroll = root.scrollWidth > innerWidth || root.scrollHeight > innerHeight ? ['page scrolls'] : [];
    const outside = [...document.querySelectorAll('p')].filter(p => {
      const box = p.getBoundingClientRect();
      return box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight;
    }).map(p => `outside: ${p.textContent}`);
    return [...scroll, ...outside];
  });
}

for (const viewport of [
  { width: 240, height: 240 },
  { width: 320, height: 240 },
  { width: 480, height: 320 },
  { width: 800, height: 480 },
]) {
  test(`at ${viewport.width}x${viewport.height} every state fits with its state word visible`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const device = await openKiosk(page, STATES.unpaired);
    for (const [state, feed] of Object.entries(STATES)) {
      device.set(feed);
      const word = page.locator('.kiosk-state');
      await expect(word).toHaveText(state);
      await expect(word).toBeInViewport({ ratio: 1 });
      expect(await fits(page), state).toEqual([]);
    }
  });
}

test('unpaired shows the 8 digits at least 28 px tall and the verification address', async ({ page }) => {
  await page.setViewportSize({ width: 240, height: 240 });
  await openKiosk(page, STATES.unpaired);
  const code = page.getByLabel('Pairing code');
  await expect(code).toHaveText('1234-5678');
  await expect(code).toBeInViewport({ ratio: 1 });
  await expect(page.getByText('https://sanctum.42nights.dev/pair')).toBeInViewport({ ratio: 1 });
  const digitHeight = await code.evaluate(element => {
    const context = document.createElement('canvas').getContext('2d')!;
    const style = getComputedStyle(element);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const metrics = context.measureText('12345678');
    return metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
  });
  expect(digitHeight).toBeGreaterThanOrEqual(28);
});

test('listening moves with the bands; stopped keeps the idle line whatever the bands say', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  const device = await openKiosk(page, STATES.listening, true);
  await expect(page.locator('.kiosk-state')).toHaveText('listening');
  await expect(page.getByText('Recording.')).toBeVisible();
  await expect.poll(async () => (await waveProfile(page)).rise).toBeGreaterThan(2 * RESTING);
  device.set(STATES.stopped);
  await expect(page.locator('.kiosk-state')).toHaveText('stopped');
  await page.waitForTimeout(2500);
  expect((await waveProfile(page)).rise).toBeLessThan(RESTING);
});

test('reconnecting, degraded and error show their warning line', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 240 });
  const device = await openKiosk(page, STATES.reconnecting);
  const warning = page.locator('.kiosk-line[data-tone]');
  await expect(warning).toHaveText('Recording on this device. Server not reachable.');
  device.set(STATES.degraded);
  await expect(warning).toHaveText('Chunk upload is behind.');
  device.set(STATES.error);
  await expect(warning).toHaveText('No microphone found.');
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('a silent feed shows error after 3 s and never listening from old data', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 240 });
  const device = await openKiosk(page, STATES.listening);
  await expect(page.locator('.kiosk-state')).toHaveText('listening');
  device.set(null);
  const stopped = Date.now();
  await expect(page.getByText('Device client not running.')).toBeVisible({ timeout: 6000 });
  expect(Date.now() - stopped).toBeGreaterThanOrEqual(2500);
  await expect(page.locator('.kiosk-state')).toHaveText('error');
  await page.waitForTimeout(1500);
  await expect(page.locator('.kiosk-state')).toHaveText('error');
});
