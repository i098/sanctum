import { expect, test, type Page } from '@playwright/test';

type LevelsModule = typeof import('../src/lib/capture/levels.ts');

const BAND_COUNT = 33;
// 48 kHz, fftSize 2048: 1 kHz falls in band 18 of 33 log-spaced 80 Hz..8 kHz bands.
const ONE_KHZ_BAND = 18;

async function renderLevels(page: Page, gain: number) {
  await page.goto('/');
  return page.evaluate(
    async ({ gain, bandCount }) => {
      const moduleUrl = '/src/lib/capture/levels.ts';
      const { createAnalyserLevels } = (await import(moduleUrl)) as LevelsModule;
      const context = new OfflineAudioContext(1, 48_000, 48_000);
      const oscillator = new OscillatorNode(context, { frequency: 1000 });
      const analyser = new AnalyserNode(context, { fftSize: 2048, smoothingTimeConstant: 0 });
      oscillator.connect(new GainNode(context, { gain })).connect(analyser).connect(context.destination);
      oscillator.start();
      const levels = createAnalyserLevels(analyser, bandCount);
      const bands = new Float32Array(bandCount);
      let level = -1;
      void context.suspend(0.5).then(() => {
        level = levels.read(bands);
        void context.resume();
      });
      await context.startRendering();
      return { level, bands: Array.from(bands) };
    },
    { gain, bandCount: BAND_COUNT },
  );
}

test('a 1 kHz tone dominates its band in real Chromium audio', async ({ page }) => {
  const { level, bands } = await renderLevels(page, 0.5);
  const loudest = bands.indexOf(Math.max(...bands));
  expect(loudest).toBe(ONE_KHZ_BAND);
  expect(level).toBeGreaterThan(0.1);
});

test('silence reads as ~0', async ({ page }) => {
  const { level, bands } = await renderLevels(page, 0);
  expect(level).toBeLessThan(1e-4);
  expect(Math.max(...bands)).toBeLessThan(0.01);
});
