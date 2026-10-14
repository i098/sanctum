/** The real capture engine on fake inputs: a dead (exact zero) input is named with a picker beside it, and the choice moves capture and persists. */
import { expect, test, type Page } from '@playwright/test';
import { fakeServer } from './capture-server.ts';
import { openMenu, menuSection } from './menu.ts';

declare global {
  interface Window {
    /** Every `getUserMedia` audio request, in order. */
    __requests: MediaTrackConstraints[];
    /** Sets one input's tone level; 0 is exact digital zero. */
    __level(id: string, gain: number): void;
    /** Removes an input and ends its open streams, as unplugging a device does. */
    __unplug(id: string): void;
    /** Adds an input; `announce` (default true) also fires the browser's `devicechange`. */
    __plug(id: string, input: { label: string; gain: number }, announce?: boolean): void;
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
  const tracks = new Map<string, MediaStreamTrack[]>();
  window.__requests = [];
  window.__level = (id, gain) => levels.get(id)?.forEach(node => (node.gain.value = gain));
  window.__plug = (id, input, announce = true) => {
    inputs[id] = input;
    if (announce) navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  };
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
    const track = destination.stream.getAudioTracks()[0]!;
    tracks.set(id, [...(tracks.get(id) ?? []), track]);
    Object.defineProperty(track, 'label', { value: input.label });
    return destination.stream;
  };
  navigator.mediaDevices.enumerateDevices = async () =>
    Object.entries(inputs).map(([deviceId, { label }]) => ({ deviceId, kind: 'audioinput', label, groupId: '' }) as MediaDeviceInfo);
  window.__unplug = (id) => {
    delete inputs[id];
    tracks.get(id)?.forEach(track => (track.stop(), track.dispatchEvent(new Event('ended'))));
  };
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
  // The chip stays in the health line; only its amber warning goes.
  await expect(page.getByRole('combobox', { name: 'Microphone' })).toBeVisible();
  await expect(page.locator('.listen-health-line')).not.toHaveAttribute('data-input-issue');
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

  await openMenu(page, 'Settings');
  await expect(menuSection(page, 'Settings').getByRole('combobox', { name: 'Microphone' })).toHaveValue('iphone');

  await page.reload();
  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(page.locator('.listen-state')).toHaveText('listening', { timeout: 15_000 });
  expect(await page.evaluate(() => window.__requests)).toMatchObject([{ deviceId: { exact: 'iphone' } }]);
});

test('keeps capture open when the input is unplugged and resumes on the first input that appears', async ({ page }) => {
  const server = await listen(page, { default: { ...INPUTS.default, gain: 0.1 } });
  await expect(page.locator('.listen-state')).toHaveText('listening', { timeout: 15_000 });

  await page.evaluate(() => window.__unplug('default'));
  await expect(page.locator('.listen-state')).toHaveText('degraded');
  await expect(helper(page)).toHaveText('Microphone disconnected. Waiting for one to connect.');
  await expect(page.locator('.listen-health')).toContainText('recording interrupted');

  await page.evaluate(() => window.__plug('default', { label: 'Default - USB Microphone', gain: 0.1 }));
  await expect(page.locator('.listen-state')).toHaveText('listening', { timeout: 15_000 });
  await expect(helper(page)).toHaveText('Speak to Sanctum when you need it.');
  expect(server.starts.map((message) => (message._tag === 'stop' ? `stop ${message.reason}` : message._tag))).toEqual(['start', 'stop interrupted', 'start']);
});

test('before listening, Settings checks the chosen input for sound', async ({ page }) => {
  await page.addInitScript(installInputs, INPUTS);
  await fakeServer(page);
  await page.goto('/');
  await openMenu(page, 'Settings');
  const settings = menuSection(page, 'Settings');
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

test('a new input appears on devicechange or Refresh, and the chosen input stays chosen', async ({ page }) => {
  await page.addInitScript(installInputs, INPUTS);
  await fakeServer(page);
  await page.goto('/');
  await openMenu(page, 'Settings');
  const settings = menuSection(page, 'Settings');
  const picker = settings.getByRole('combobox', { name: 'Microphone' });
  await picker.selectOption({ label: '萧 Microphone' });
  await expect(picker.locator('option')).toHaveCount(4);

  await page.evaluate(() => window.__plug('usb', { label: 'USB Microphone', gain: 0.1 }, true));
  await expect(picker.locator('option', { hasText: 'USB Microphone' })).toHaveCount(1);
  await expect(picker).toHaveValue('iphone');

  await page.evaluate(() => window.__plug('desk', { label: 'Desk Microphone', gain: 0.1 }, false));
  await expect(picker.locator('option', { hasText: 'Desk Microphone' })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Refresh' }).click();
  await expect(picker.locator('option', { hasText: 'Desk Microphone' })).toHaveCount(1);
  await expect(picker).toHaveValue('iphone');
});

test('a silent input says what to do when the laptop is closed', async ({ page }) => {
  await page.addInitScript(installInputs, INPUTS);
  await fakeServer(page);
  await page.goto('/');
  await openMenu(page, 'Settings');
  await expect(menuSection(page, 'Settings').locator('.listen-input-hint')).toHaveText('If your laptop is closed, choose another microphone.', { timeout: 6_000 });
});

test('a silent input that is not the built-in microphone gets no laptop hint', async ({ page }) => {
  await page.addInitScript(installInputs, INPUTS);
  await fakeServer(page);
  await page.goto('/');
  await openMenu(page, 'Settings');
  const settings = menuSection(page, 'Settings');
  await settings.getByRole('combobox', { name: 'Microphone' }).selectOption({ label: 'LoomAudioDevice' });
  await expect(settings.locator('.listen-input-check')).toHaveText('This input is sending no sound.', { timeout: 6_000 });
  await expect(settings.locator('.listen-input-hint')).toHaveCount(0);
});
