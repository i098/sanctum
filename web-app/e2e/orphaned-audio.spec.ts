/** Recordings orphaned by a removed listener, on the real IndexedDB buffer and the real page engine. */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type * as Buffer from '../src/lib/capture/buffer.ts';
import type * as Recorder from '../src/lib/capture/recorder.ts';

type BufferModule = typeof Buffer;
type RecorderModule = typeof Recorder;
interface Fixture { listener: string; epoch: string; sequence: number; start: number; count: number }

const RATE = 16_000;
const OWNED = '7d3b1f0e-2a4c-4e8b-9f1d-5c6a7b8c9d01';
const REMOVED = '7d3b1f0e-2a4c-4e8b-9f1d-5c6a7b8c9d02';
const EPOCHS = ['7d3b1f0e-2a4c-4e8b-9f1d-5c6a7b8c9e01', '7d3b1f0e-2a4c-4e8b-9f1d-5c6a7b8c9e02', '7d3b1f0e-2a4c-4e8b-9f1d-5c6a7b8c9e03'] as const;

/** Seals fixture chunks (sample values = epoch sample positions) into the page's recovery buffer. */
async function seed(page: Page, fixtures: Fixture[]): Promise<void> {
  await page.goto('/');
  // The Vite dev server reloads the page once when it first optimizes the capture dependencies.
  await page.evaluate(() => import('/src/lib/capture/buffer.ts' as string)).catch(() => page.waitForLoadState('load'));
  await page.evaluate(async ({ fixtures, rate }) => {
    const { RecoveryBuffer } = (await import('/src/lib/capture/buffer.ts' as string)) as BufferModule;
    const { sealChunk } = (await import('/src/lib/capture/recorder.ts' as string)) as RecorderModule;
    const buffer = await RecoveryBuffer.open();
    for (const { listener, epoch, sequence, start, count } of fixtures) {
      const samples = Int16Array.from({ length: count }, (_, index) => (start + index) % 32_768);
      const captured_at = new Date(Date.UTC(2026, 8, 29, 9) + (start / rate) * 1000).toISOString();
      await buffer.sealChunk(await sealChunk({ chunk_id: crypto.randomUUID(), listener_id: listener, epoch_id: epoch, sequence, sample_rate: rate, chunk_start: start, captured_at }, samples));
    }
    buffer.close();
  }, { fixtures, rate: RATE });
}

test('discard deletes only the chosen orphaned recording, never pending audio', async ({ page }) => {
  await seed(page, [
    { listener: OWNED, epoch: EPOCHS[0], sequence: 0, start: 0, count: RATE },
    { listener: REMOVED, epoch: EPOCHS[1], sequence: 0, start: 0, count: RATE },
    { listener: REMOVED, epoch: EPOCHS[1], sequence: 1, start: RATE, count: RATE },
    { listener: REMOVED, epoch: EPOCHS[2], sequence: 0, start: 10 * RATE, count: RATE },
  ]);
  const result = await page.evaluate(async ({ owned, removed, epochs }) => {
    const { RecoveryBuffer } = (await import('/src/lib/capture/buffer.ts' as string)) as BufferModule;
    const buffer = await RecoveryBuffer.open();
    const before = (await buffer.orphanedRecordings([owned])).map(recording => [recording.epochId, recording.chunkCount]);
    await buffer.discardRecording(removed, epochs[1], [owned]);
    await buffer.discardRecording(owned, epochs[0], [owned]);
    const after = (await buffer.orphanedRecordings([owned])).map(recording => [recording.epochId, recording.chunkCount]);
    return { before, after, counts: await buffer.countChunks(owned), pending: (await buffer.nextPending(owned))?.manifest.epoch_id };
  }, { owned: OWNED, removed: REMOVED, epochs: EPOCHS });
  expect(result).toEqual({
    before: [[EPOCHS[1], 2], [EPOCHS[2], 1]],
    after: [[EPOCHS[2], 1]],
    counts: { pending: 1, stranded: 1 },
    pending: EPOCHS[0],
  });
});

test('exports an orphaned recording as one WAV, then discards it only after confirmation', async ({ page }) => {
  await seed(page, [
    { listener: REMOVED, epoch: EPOCHS[1], sequence: 0, start: 0, count: RATE },
    { listener: REMOVED, epoch: EPOCHS[1], sequence: 2, start: 2 * RATE, count: RATE },
  ]);
  await page.reload();
  await expect(page.getByText('2 chunks kept on this device, not uploadable')).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const row = settings.getByRole('listitem');
  await expect(row).toContainText('0:02 · 2 chunks · listener removed');
  await expect(row).toContainText('Gap: 0:01 missing after 0:01, not filled in the export');

  const download = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Export WAV' }).click();
  const file = await readFile((await (await download).path())!);
  expect(file.toString('ascii', 0, 4) + file.toString('ascii', 8, 12)).toBe('RIFFWAVE');
  expect([file.readUInt32LE(24), file.readUInt32LE(40)]).toEqual([RATE, 2 * RATE * 2]);
  const samples = new Int16Array(file.buffer.slice(file.byteOffset + 44, file.byteOffset + file.length));
  expect([samples[0], samples[RATE - 1], samples[RATE], samples.at(-1)]).toEqual([0, RATE - 1, 2 * RATE, (3 * RATE - 1) % 32_768]);

  const discard = row.getByRole('button', { name: 'Discard' });
  await discard.click();
  const confirm = page.getByRole('dialog', { name: 'Discard local recording?' });
  await expect(confirm).toContainText('0:02 · 2 chunks from this device');
  for (let press = 0; press < 4; press++) {
    await page.keyboard.press('Tab');
    expect(await confirm.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(settings).toBeVisible();
  await expect(discard).toBeFocused();

  await discard.click();
  await confirm.getByRole('button', { name: 'Discard recording' }).click();
  await expect(settings.getByText('None on this device.')).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'Local recordings that cannot be uploaded' })).toBeFocused();
  await expect(page.getByText('not uploadable')).toBeHidden();
  expect(await page.evaluate(async () => {
    const { RecoveryBuffer } = (await import('/src/lib/capture/buffer.ts' as string)) as BufferModule;
    return (await RecoveryBuffer.open()).countChunks(null);
  })).toEqual({ pending: 0, stranded: 0 });
});
