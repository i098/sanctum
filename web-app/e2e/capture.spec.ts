/** Real-browser capture against the harness in capture-server.ts. */
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type * as Engine from '../src/pages/listen/engine.ts';
import { capture, fakeServer, LISTENER, snapshot } from './capture-server.ts';

type EngineModule = typeof Engine;

function wavInfo(body: globalThis.Buffer) {
  const samples = new Int16Array(body.buffer.slice(body.byteOffset + 44, body.byteOffset + body.length));
  return { tag: body.toString('ascii', 0, 4) + body.toString('ascii', 8, 12), rate: body.readUInt32LE(24), samples, peak: samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0) };
}

// Chromium's synthetic microphone with its permission prompt auto-accepted.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });


test('records the microphone into contiguous valid WAV chunks and streams live frames', async ({ page }) => {
  const server = await fakeServer(page);
  await capture(page, { start: true, chunkSeconds: 1 });
  await expect.poll(() => server.uploads.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await snapshot(page)).listener).toBe('listening');

  const [first, second] = server.uploads;
  for (const { manifest, body } of [first!, second!]) {
    const wav = wavInfo(body);
    expect(wav.tag).toBe('RIFFWAVE');
    expect(wav.rate).toBe(manifest.sample_rate);
    expect(wav.samples.length).toBe(manifest.sample_count);
    expect(manifest.sample_count).toBe(manifest.sample_rate);
    expect(wav.peak).toBeGreaterThan(1_000);
    expect(createHash('sha256').update(body).digest('hex')).toBe(manifest.sha256);
  }
  expect(second!.manifest.epoch_id).toBe(first!.manifest.epoch_id);
  expect(second!.manifest.sample_start).toBe(first!.manifest.sample_start + first!.manifest.sample_count);
  expect(server.starts[0]).toMatchObject({ _tag: 'start', listener_id: LISTENER, epoch_id: first!.manifest.epoch_id, clock: { sample_start: 0, encoding: 'pcm_s16le' } });
  expect(server.frames).toBeGreaterThan(20);
  const level = await page.evaluate(() => window.capture.levels.read(new Float32Array(window.capture.levels.bandCount)));
  expect(level).toBeGreaterThan(0);

  const same = await page.evaluate(async () => {
    const { getCaptureEngine } = (await import('/src/pages/listen/engine.ts' as string)) as EngineModule;
    return getCaptureEngine() === getCaptureEngine();
  });
  expect(same).toBe(true);
});

test('keeps unacknowledged audio across a reload and uploads it as an interrupted capture', async ({ page }) => {
  const server = await fakeServer(page, true);
  await capture(page, { start: true, chunkSeconds: 30 });
  await page.waitForTimeout(1_700); // real microphone time: three committed half-second parts
  await page.reload();

  await capture(page, { start: false, chunkSeconds: 30 });
  await expect.poll(async () => (await snapshot(page)).archive).toBe('interrupted');
  expect((await snapshot(page)).bufferedChunks).toBe(1);
  expect(server.uploads).toEqual([]);

  await page.reload();
  await capture(page, { start: false, chunkSeconds: 30 });
  await expect.poll(async () => (await snapshot(page)).bufferedChunks).toBe(1);

  server.failUploads = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => server.uploads.length, { timeout: 15_000 }).toBe(1);
  const { manifest, body } = server.uploads[0]!;
  expect(manifest.sample_start).toBe(0);
  expect(manifest.sample_count % (manifest.sample_rate / 2)).toBe(0);
  expect(manifest.sample_count).toBeGreaterThanOrEqual(manifest.sample_rate);
  expect(wavInfo(body).samples.length).toBe(manifest.sample_count);
  await expect.poll(async () => (await snapshot(page)).bufferedChunks).toBe(0);
});

test('pauses visibly when the recovery buffer is full and keeps what it stored', async ({ page }) => {
  await fakeServer(page, true);
  await capture(page, { start: true, chunkSeconds: 30, capBytes: 150_000 });
  // Pausing stops the microphone asynchronously after the issue is published; wait for the settled state.
  await expect.poll(async () => snapshot(page), { timeout: 10_000 }).toMatchObject({ issue: 'storage_full', listener: 'paused', bufferedChunks: 1 });
});

test('reports missing audio when site data is cleared during capture', async ({ page }) => {
  await fakeServer(page, true);
  await capture(page, { start: true, chunkSeconds: 30 });
  await expect.poll(async () => (await snapshot(page)).epochId).not.toBeNull();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Storage.clearDataForOrigin', { origin: new URL(page.url()).origin, storageTypes: 'indexeddb' });
  await expect.poll(async () => snapshot(page)).toMatchObject({ archive: 'missing', listener: 'paused', issue: 'storage_unavailable' });
});

test('refuses to capture when IndexedDB is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: undefined });
  });
  await fakeServer(page);
  await capture(page, { start: true, chunkSeconds: 30 });
  expect(await snapshot(page)).toMatchObject({ listener: 'stopped', issue: 'storage_unavailable', archive: null });
});
