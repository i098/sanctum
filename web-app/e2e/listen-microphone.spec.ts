/** The real capture engine on fake inputs: a dead (exact zero) input is named with a picker beside it, and the choice moves capture and persists. */
import { expect, test, type Page } from '@playwright/test';
import { fakeServer } from './capture-server.ts';

declare global {
  interface Window {
    /** Every `getUserMedia` audio request, in order. */
    __requests: MediaTrackConstraints[];
    /** Sets one input's tone level; 0 is exact digital zero. */
    __level(id: string, gain: number): void;
  }
}

/** The captain's inputs: the closed MacBook's built-in microphone is the default (dead), then his iPhone and a virtual device. */
const INPUTS = {
  default: { label: 'Default - MacBook Pro Microphone', gain: 0 },
  builtin: { label: 'MacBook Pro Microphone', gain: 0 },
  iphone: { label: '萧 Microphone', gain: 0.1 },
  loom: { label: 'LoomAudioDevice', gain: 0 },
};

/** Replaces the browser's inputs with tones whose level the test sets. Runs in the page. */
function installInputs(inputs: Record<string, { label: string; gain: number; fail?: string }>): void {
  const levels = new Map<string, GainNode[]>();
  window.__requests = [];
  window.__level = (id, gain) => levels.get(id)?.forEach(node => (node.gain.value = gain));
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const audio = constraints?.audio as MediaTrackConstraints;
    window.__requests.push(audio);
    const id = ((audio.deviceId as ConstrainDOMStringParameters | undefined)?.exact as string | undefined) ?? 'default';
    const input = inputs[id];
    if (input === undefined) throw new DOMException('no such input', 'OverconstrainedError');
    if (input.fail) throw new DOMException('busy', input.fail);
    const context = new AudioContext();
    const level = new GainNode(context, { gain: input.gain });
    const destination = context.createMediaStreamDestination();
    const tone = new OscillatorNode(context, { frequency: 440 });
    tone.connect(level).connect(destination);
    tone.start();
    await context.resume();
    levels.set(id, [...(levels.get(id) ?? []), level]);
    Object.defineProperty(destination.stream.getAudioTracks()[0], 'label', { value: input.label });
    return destination.stream;
  };
  navigator.mediaDevices.enumerateDevices = async () =>
    Object.entries(inputs).map(([deviceId, { label }]) => ({ deviceId, kind: 'audioinput', label, groupId: '' }) as MediaDeviceInfo);
}

async function listen(page: Page, inputs: Record<string, { label: string; gain: number; fail?: string }> = INPUTS) {
  await page.addInitScript(installInputs, inputs);
  const server = await fakeServer(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Listen' }).click();
  return server;
}

const helper = (page: Page) => page.locator('.listen-helper').first();

test('names a microphone that sends exact zero within the threshold, and clears the warning when sound arrives', async ({ page }) => {
  await listen(page);
  await expect(page.locator('.listen-state')).toHaveText('listening', { timeout: 15_000 });
  await expect(helper(page)).toHaveText('MacBook Pro Microphone is sending no sound.', { timeout: 6_000 });
  await expect(page.locator('.listen-state')).toHaveText('degraded');
  await expect(page.getByRole('combobox', { name: 'Microphone' })).toBeVisible();

  await page.evaluate(() => window.__level('default', 0.1));
  await expect(helper(page)).toHaveText('Speak to Sanctum when you need it.');
  await expect(page.getByRole('combobox', { name: 'Microphone' })).toHaveCount(0);
});

test('never warns about a quiet input that is not exact zero', async ({ page }) => {
  await listen(page, { ...INPUTS, default: { ...INPUTS.default, gain: 0.0005 } });
  await expect(page.locator('.listen-state')).toHaveText('listening', { timeout: 15_000 });
  await page.waitForTimeout(5_000);
  await expect(page.locator('.listen-state')).toHaveText('listening');
  await expect(helper(page)).toHaveText('Speak to Sanctum when you need it.');
});

test('choosing another input moves the same capture to it, and the choice persists', async ({ page }) => {
  const server = await listen(page);
  const picker = page.getByRole('combobox', { name: 'Microphone' });
  await expect(picker).toBeVisible({ timeout: 15_000 });
  await expect(picker.locator('option')).toHaveText(['System default (MacBook Pro Microphone)', 'MacBook Pro Microphone', '萧 Microphone', 'LoomAudioDevice']);

  await picker.selectOption({ label: '萧 Microphone' });
  await expect(helper(page)).toHaveText('Speak to Sanctum when you need it.');
  expect(await page.evaluate(() => window.__requests.at(-1))).toMatchObject({ deviceId: { exact: 'iphone' } });
  expect(await page.evaluate(() => localStorage.getItem('sanctum.microphone'))).toBe('iphone');
  expect(server.starts).toHaveLength(1);

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('combobox', { name: 'Microphone' })).toHaveValue('iphone');

  await page.reload();
  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(page.locator('.listen-state')).toHaveText('listening', { timeout: 15_000 });
  expect(await page.evaluate(() => window.__requests)).toMatchObject([{ deviceId: { exact: 'iphone' } }]);
});

test('before listening, Settings checks the chosen input for sound', async ({ page }) => {
  await page.addInitScript(installInputs, INPUTS);
  await fakeServer(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const check = settings.locator('.listen-input-check');
  await expect(check).toHaveText('This input is sending no sound.', { timeout: 6_000 });

  await settings.getByRole('combobox', { name: 'Microphone' }).selectOption({ label: '萧 Microphone' });
  await expect(check).toHaveText('This input is sending sound.');
  expect(await page.evaluate(() => window.__requests.at(-1))).toMatchObject({ deviceId: { exact: 'iphone' } });
  expect(await page.evaluate(() => localStorage.getItem('sanctum.microphone'))).toBe('iphone');
});

test('the picker on the listening page opens no probe stream while capture is stopped', async ({ page }) => {
  await page.addInitScript(installInputs, { default: { label: 'Default - MacBook Pro Microphone', gain: 0, fail: 'NotReadableError' }, iphone: INPUTS.iphone });
  await fakeServer(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(helper(page)).toHaveText('The microphone reported a hardware error.');
  const picker = page.getByRole('combobox', { name: 'Microphone' });
  await picker.selectOption({ label: '萧 Microphone' });
  await expect(picker).toHaveValue('iphone');
  await expect(page.locator('.listen-input-check')).toHaveCount(0);
  expect(await page.evaluate(() => window.__requests)).toMatchObject([{}]);
});
