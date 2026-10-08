import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openListening, openMeeting, waveProfile } from './listen-fake.ts';

const MEETING = '5f0c6f7e-8d1b-4c2a-9e3f-1a2b3c4d5e6f';

const REFERENCE = readFileSync(new URL('../../design/listener-reference.svg', import.meta.url), 'utf8');

interface Box { left: number; right: number; centerX: number; centerY: number }

const toBox = ({ x, y, width, height }: { x: number; y: number; width: number; height: number }): Box =>
({ left: x, right: x + width, centerX: x + width / 2, centerY: y + height / 2 });

/** Text boxes of the reference SVG at 1280 × 720, where SVG user units equal CSS pixels. */
async function referenceBoxes(page: Page): Promise<Record<string, Box>> {
  await page.setContent(`<body style="margin:0">${REFERENCE}</body>`);
  const boxes = await page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('text')].map(text => {
      const { x, y, width, height } = text.getBBox();
      return [text.textContent!.trim(), { x, y, width, height }] as const;
    })));
  return Object.fromEntries(Object.entries(boxes).map(([text, box]) => [text, toBox(box)]));
}

async function box(locator: Locator): Promise<Box> {
  return toBox((await locator.boundingBox())!);
}

test('1280 × 720 matches the reference composition', async ({ page }, testInfo) => {
  const reference = await referenceBoxes(page);
  await testInfo.attach('reference-1280x720', { body: await page.screenshot(), contentType: 'image/png' });
  await openListening(page);
  await openMeeting(page, MEETING, 'Product sync');
  await page.evaluate(() => window.__capture.setGain(0.8));
  await page.waitForTimeout(400);
  await testInfo.attach('listening-1280x720', { body: await page.screenshot(), contentType: 'image/png' });

  const pairs: Array<[string, Locator, keyof Box]> = [
    ['✦ SANCTUM', page.locator('.listen-wordmark'), 'left'],
    ['10:24 AM', page.locator('.listen-clock span').first(), 'left'],
    ['Mon, Sep 28', page.locator('.listen-clock span').last(), 'left'],
    ['Product sync', page.locator('.listen-meeting'), 'right'],
    ['listening', page.locator('.listen-state'), 'centerX'],
    ['Speak to Sanctum when you need it.', page.locator('.listen-helper'), 'centerX'],
    ['PAUSE    REVIEW    AGENTS    FULLSCREEN    SETTINGS', page.getByRole('button', { name: 'Settings' }), 'right'],
  ];
  for (const [text, locator, anchor] of pairs) {
    const want = reference[text]!;
    const got = await box(locator);
    expect.soft(Math.abs(got.centerY - want.centerY), `${text} vertical`).toBeLessThanOrEqual(6);
    expect.soft(Math.abs(got[anchor] - want[anchor]), `${text} ${anchor}`).toBeLessThanOrEqual(10);
  }
  const health = await box(page.locator('.listen-health'));
  expect(Math.abs(health.left - 32.5)).toBeLessThanOrEqual(3);
  expect(Math.abs(health.centerY - reference['Silent · context shared with your agents']!.centerY)).toBeLessThanOrEqual(6);

  const wave = await waveProfile(page);
  expect(Math.abs(wave.baseline - 315)).toBeLessThanOrEqual(3);
  expect(Math.abs(wave.left - 260)).toBeLessThanOrEqual(4);
  expect(Math.abs(wave.right - 1020)).toBeLessThanOrEqual(4);
});

test('narrow laptop keeps the same hierarchy without scrolling or overlap, live updates included', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await openListening(page);
  await openMeeting(page, MEETING, 'Product sync');
  await page.evaluate(() => window.__capture.setGain(0.8));
  await page.evaluate(() => { for (let n = 0; n < 12; n++) window.__capture.transcript(`line ${n}: what the room said, long enough to wrap across the rail`, '0'); });
  await page.waitForTimeout(400);
  await testInfo.attach('listening-1024x640', { body: await page.screenshot(), contentType: 'image/png' });

  const size = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(size).toEqual({ scrollWidth: 1024, scrollHeight: 640 });
  const wave = await waveProfile(page);
  expect(Math.abs(wave.baseline - 640 * (316 / 720))).toBeLessThanOrEqual(3);
  expect(Math.abs(wave.right - wave.left - 760)).toBeLessThanOrEqual(4);

  // Loud needles keep their full height: the kiosk's 300 px stage cut them flat at 150 px.
  expect(wave.rise).toBeGreaterThan(150);
  const status = (await page.locator('.listen-status').boundingBox())!;
  const footer = (await page.locator('.listen-footer').boundingBox())!;
  for (const item of [page.locator('.listen-brand'), page.locator('.listen-meeting')]) {
    const { x, y, width, height } = (await item.boundingBox())!;
    expect(y + height).toBeLessThan(Math.min(...wave.tops.slice(Math.floor(x), Math.ceil(x + width))));
  }
  expect(status.y).toBeGreaterThan(wave.baseline + wave.fall);
  expect(status.y + status.height).toBeLessThan(footer.y);
  const helper = (await page.locator('.listen-helper').boundingBox())!;
  const transcript = (await page.getByRole('region', { name: 'Live transcript' }).boundingBox())!;
  expect(transcript.y).toBeGreaterThan(wave.baseline + wave.fall);
  expect(transcript.y + transcript.height).toBeLessThan(footer.y);
  expect(transcript.x + transcript.width).toBeLessThan(helper.x);
  const controls = await page.getByRole('navigation', { name: 'Listening controls' }).getByRole('button').all();
  const rows = new Set(await Promise.all(controls.map(async control => (await control.boundingBox())!.y)));
  expect(controls).toHaveLength(5);
  expect(rows.size).toBe(1);
});
