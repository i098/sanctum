/** V1–V7 against the real API, a disposable MySQL database and synthetic audio only. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { HttpServer } from '@effect/platform';
import { SqlClient } from '@effect/sql';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { ListenerId } from '@sanctum/contracts';
import { syntheticPcm } from '@sanctum/contracts/fixtures';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { KernelAuthenticatorLive, openSession } from '../server/src/auth.ts';
import { dbLayer } from '../server/src/db.ts';
import { serverLayer } from '../server/src/main.ts';
import { loadMigrations, migrate } from '../server/src/migrate.ts';
import { SpeechToText } from '../server/src/providers/whisper.ts';
import { createDatabaseOn } from '../server/tests/support/database.ts';
import { seedWorkspace } from '../server/tests/support/fixtures.ts';
import { chunk, claimListener, fakeSpeech, newEpochId, openSocket, startMessage } from '../server/tests/support/media.ts';
import type {} from '../server/tests/support/mysql-server.ts';
import { memoryObjectStore } from '../server/tests/support/object-store.ts';
import { openMenu } from '../web-app/e2e/menu.ts';
import { childEnv } from './check-app.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const deviceRoot = join(root, 'devices');
const webRoot = join(root, 'web-app/dist');
const sampleRate = 16_000;
const chunkSamples = 30 * sampleRate;
const sentence = 'Review the synthetic capture with the team.';
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

type Indication = { t_ms: number; state: string; lit: boolean };
type Credential = { access_token: string; device_id: string; listener_id: ListenerId };
type Session = { token: string; csrf_token: string };
interface DeviceProcess {
  creds: string;
  log: string;
  rows(): Indication[];
  exited: Promise<number>;
  output(): string;
  credential(): Promise<Credential>;
  stop(): Promise<void>;
}

async function until<T>(label: string, read: () => T | undefined | Promise<T | undefined>, timeout = 10_000): Promise<T> {
  const deadline = performance.now() + timeout;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await delay(25);
  } while (performance.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

function build(file: string, args: string[], cwd: string) {
  const result = spawnSync(file, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${file} ${args.join(' ')}`);
}

/** Put the device behind one link that can drop both HTTP and WebSocket connections. */
async function deviceLink(apiPort: number) {
  const sockets = new Set<Socket>();
  const codes: string[] = [];
  let online = true;
  const link = createServer((incoming, outgoing) => {
    const remote = request({ hostname: '127.0.0.1', port: apiPort, method: incoming.method, path: incoming.url, headers: incoming.headers }, response => {
      if (incoming.url === '/api/v1/device/authorize' && response.statusCode === 200) {
        const parts: Buffer[] = [];
        response.on('data', part => parts.push(part));
        response.once('end', () => codes.push(JSON.parse(Buffer.concat(parts).toString()).user_code));
      }
      outgoing.writeHead(response.statusCode!, response.headers);
      response.pipe(outgoing);
    });
    remote.once('error', () => outgoing.destroy());
    outgoing.once('close', () => remote.destroy());
    incoming.pipe(remote);
  });
  link.on('connection', socket => {
    if (!online) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  link.on('upgrade', (req, socket, head) => {
    const remote = connect({ host: '127.0.0.1', port: apiPort });
    const headers = Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n');
    remote.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head.length !== 0) remote.write(head);
    socket.pipe(remote).pipe(socket);
    remote.once('error', () => socket.destroy());
    socket.once('error', () => remote.destroy());
    remote.once('close', () => socket.destroy());
    socket.once('close', () => remote.destroy());
  });
  const ready = once(link, 'listening');
  link.listen(0, '127.0.0.1');
  await ready;
  const address = link.address();
  assert(address && typeof address !== 'string');
  const disconnect = () => { online = false; sockets.forEach(socket => socket.destroy()); };
  return {
    origin: `http://127.0.0.1:${address.port}`, codes, disconnect,
    reconnect: () => { online = true; },
    close: () => { disconnect(); link.close(); },
  };
}

function startDevice(binary: string, scratch: string, origin: string, name: string, input: string, screen: string): DeviceProcess {
  const state = join(scratch, name);
  const log = join(scratch, `${name}.jsonl`);
  const creds = join(state, 'credential.json');
  const terminal = screen === 'none';
  const args = ['--server', origin, '--name', name, '--state-dir', state, '--input', input,
    '--light', terminal ? 'term' : 'none', '--screen', screen, '--indication-log', log];
  const process = terminal
    ? spawn('script', ['-qefc', `exec ${[binary, ...args].map(quote).join(' ')}`, '/dev/null'])
    : spawn(binary, args);
  process.stdout.on('data', data => { stdout += data.toString(); });
  process.stderr.on('data', data => { stdout += data.toString(); });
  let stdout = '';
  const exited = once(process, 'exit').then(([code, signal]) => {
    if (typeof code !== 'number') throw new Error(`${name} exited with ${signal}`);
    return code;
  });
  void exited.catch(() => {});
  function rows(): Indication[] {
    if (!existsSync(log)) return [];
    return readFileSync(log, 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line));
  }
  return {
    creds, log, rows, exited, output: () => stdout,
    credential: () => until<Credential>(`${name} registered listener`, () => {
      if (!existsSync(creds)) return;
      const saved: Credential | (Omit<Credential, 'listener_id'> & { listener_id: null }) = JSON.parse(readFileSync(creds, 'utf8'));
      if (saved.listener_id !== null) return saved;
    }),
    stop: async () => {
      if (process.kill('SIGTERM')) {
        await Promise.race([exited.catch(() => {}), delay(2_000, undefined, { ref: false })]);
        if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
      }
    },
  };
}

function* blinkCycles(pulses: readonly Indication[]) {
  let groups = [1];
  for (let i = 1; i < pulses.length; i++) {
    const gap = pulses[i].t_ms - pulses[i - 1].t_ms;
    // The interdigit gap is 1.4 s. The next cycle starts after a 3.4 s gap.
    if (gap > 2_500) {
      yield groups;
      groups = [1];
    } else if (gap > 900) groups.push(1);
    else groups[groups.length - 1]++;
  }
}

function checkBlinks(rows: () => Indication[], code: string) {
  const digits = [...code.replace('-', '')].map(digit => Number(digit) || 10).join(',');
  return until('complete eight-digit cycle on the terminal light', () => {
    const pulses = rows().filter(row => row.state === 'unpaired' && row.lit);
    for (const cycle of blinkCycles(pulses)) if (cycle.join(',') === digits) return true;
  }, 90_000);
}

function checkReconnect(rows: Indication[]) {
  const first = rows.findIndex(row => row.state === 'reconnecting');
  assert(first >= 0, 'reconnecting is visible');
  const recovered = rows.findIndex((row, index) => index > first && row.state !== 'reconnecting');
  assert(recovered > first, 'the device left reconnecting');
  const transitions = rows.slice(first, recovered + 1);
  const begin = transitions[0].t_ms;
  const end = transitions.at(-1)!.t_ms;
  assert(end - begin >= 8_000, 'reconnecting spans the outage');
  const intervals = transitions.slice(0, -1);
  const darkMs = (start: number) => intervals.reduce((sum, row, index) =>
    row.lit ? sum : sum + Math.max(0, Math.min(start + 1_000, transitions[index + 1].t_ms) - Math.max(start, row.t_ms)), 0);
  // The dark time can change slope only when either edge meets a transition.
  const starts = transitions.flatMap(({ t_ms }) => [t_ms, t_ms - 1_000]).filter(start => start >= begin && start + 1_000 <= end);
  for (const start of starts) assert(darkMs(start) <= 200, `reconnecting is dark for more than 200 ms from ${start}`);
}

function sessionHeaders(session: Session) {
  return { cookie: `sanctum_session=${session.token}`, 'x-csrf-token': session.csrf_token, 'content-type': 'application/json' };
}

async function sessionPage(browser: Browser, origin: string, session: Session) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.context().addCookies([
    { name: 'sanctum_session', value: session.token, url: origin, httpOnly: true },
    { name: 'sanctum_csrf', value: session.csrf_token, url: origin, sameSite: 'Strict' },
  ]);
  return page;
}

async function screenshot(page: Page, directory: string | undefined, name: string) {
  if (directory !== undefined) await page.screenshot({ path: join(directory, name) });
}

async function stopDevices(devices: DeviceProcess[], directory: string | undefined) {
  await Promise.all(devices.map(device => device.stop()));
  if (directory === undefined) return;
  for (const device of devices) {
    const name = device.log.split('/').at(-1)!;
    if (existsSync(device.log)) writeFileSync(join(directory, name), readFileSync(device.log));
    writeFileSync(join(directory, name.replace('.jsonl', '.terminal.log')), device.output());
  }
}

async function openMeetings(page: Page, origin: string) {
  await page.goto(origin);
  await page.getByRole('dialog', { name: 'Welcome to Sanctum' }).getByRole('button', { name: 'Skip', exact: true }).click();
  return openMenu(page, 'Meetings');
}

async function probeInvalidStart(host: string, token: string) {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const lease = yield* claimListener(host, token, 'Invalid start probe');
    const socket = yield* openSocket(host, lease.listener_id, token);
    const start = JSON.parse(startMessage({ ...lease, epoch_id: newEpochId(), captured_at: new Date().toISOString() }));
    socket.send(JSON.stringify({ ...start, capabilities: { mic: true, screen: false, light: 'none', speaker: false } }));
    assert.equal((yield* socket.take('rejected')).reason, 'invalid_start');
    assert.equal((yield* Effect.timeout(socket.closed, '5 seconds')).code, 1008);
  })));
}

type StoredChunk = { sample_start: number; sample_count: number; digest: string; object_key: string; upload_state: string };

function checkFirstAudio(rows: Indication[] | undefined) {
  assert(rows, 'indications before the first frame');
  const starting = rows.findIndex(row => row.state === 'starting');
  const listening = rows.findIndex(row => row.state === 'listening');
  assert(starting >= 0 && starting < listening);
  assert.equal(rows[listening].lit, true);
}

function checkArchive(
  rows: readonly StoredChunk[],
  samples: Int16Array,
  expectedWav: (samples: Int16Array) => Uint8Array,
  objects: ReadonlyMap<string, { readonly body: Uint8Array }>,
) {
  assert.equal(rows.length, Math.ceil(samples.length / chunkSamples));
  for (const [index, row] of rows.entries()) {
    const offset = index * chunkSamples;
    const pcm = samples.subarray(offset, offset + chunkSamples);
    const expected = expectedWav(pcm);
    assert.equal(Number(row.sample_start), offset);
    assert.equal(Number(row.sample_count), pcm.length);
    assert.equal(row.upload_state, 'committed');
    assert.equal(row.digest, sha(expected));
    assert.deepEqual(objects.get(row.object_key)?.body, expected);
  }
}

async function runSuite(admin: string, binary: string, screenshots: string | undefined) {
  const scratch = mkdtempSync(join(tmpdir(), 'sanctum-device-e2e-'));
  const scope = Effect.runSync(Scope.make());
  const cleanup: Array<() => void | Promise<void>> = [() => rmSync(scratch, { force: true, recursive: true })];
  const devices: DeviceProcess[] = [];
  const inScope = <R, E>(layer: Layer.Layer<R, E>) => Effect.runPromise(Scope.extend(Layer.build(layer), scope));
  try {
    const database = await createDatabaseOn(admin);
    cleanup.push(database.drop, () => Effect.runPromise(Scope.close(scope, Exit.void)));
    const db = await inScope(dbLayer(database.mysql));
    const sql = Context.get(db, SqlClient.SqlClient);
    const query = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.runPromise(Effect.provide(effect, db));
    const seed = await query(Effect.gen(function* () {
      yield* migrate(loadMigrations());
      const [approver, other] = yield* seedWorkspace('Fixture workspace', ['member', 'member']);
      yield* sql`UPDATE principals SET display_name = 'Fixture approver' WHERE id = ${approver.principal.id}`;
      return { approver, session: yield* openSession({ workspace_id: approver.workspace_id, principal_id: approver.principal.id }),
        other: yield* openSession({ workspace_id: other.workspace_id, principal_id: other.principal.id }) };
    }));
    const speech = fakeSpeech();
    const objects = memoryObjectStore();
    let firstAudioIndications: Indication[] | undefined;
    const observedSpeech = Layer.effect(SpeechToText, Effect.map(SpeechToText, service => ({
      ...service,
      openStream: (...args) => Effect.suspend(() => {
        firstAudioIndications ??= devices[0]?.rows();
        return service.openStream(...args);
      }),
    }))).pipe(Layer.provide(speech.layer));
    const media = Layer.merge(observedSpeech, objects.layer);
    const service = await inScope(serverLayer({ apiPort: 0, mysql: database.mysql, webRoot }, KernelAuthenticatorLive, { media }));
    const address = Context.get(service, HttpServer.HttpServer).address;
    assert(address._tag === 'TcpAddress');
    const host = `127.0.0.1:${address.port}`;
    const origin = `http://${host}`;
    const link = await deviceLink(address.port);
    cleanup.push(link.close);
    const browser = await chromium.launch();
    cleanup.push(() => browser.close());
    const samples = syntheticPcm({ sampleRate, seconds: 62, toneHz: 317 });
    const upload = (listener_id: ListenerId, pcm: Int16Array) => chunk({ listener_id, epoch_id: newEpochId(), sequence: 0, sample_start: 0, samples: pcm });
    const wav = join(scratch, 'input.wav');
    const raw = upload(ListenerId.make('11111111-1111-4111-8111-111111111111'), samples).body;
    writeFileSync(wav, raw);
    const waitSpeech = (from: number) => until('synthetic audio reaches speech-to-text', () => speech.streams.slice(from).find(stream => stream.received >= sampleRate));
    const result = { start_s: 0, end_s: 1, is_final: true, text: sentence, confidence: 0.9, speaker: 'fixture' };
    const meeting = (listener: ListenerId) => until('provisional meeting and transcript', async () => (await query(sql<{ id: string }>`
      SELECT m.id FROM meetings m JOIN meeting_access a ON a.meeting_id = m.id JOIN meeting_ranges r ON r.meeting_id = m.id
      JOIN transcript_segments s ON s.epoch_id = r.epoch_id
      WHERE m.listener_id = ${listener} AND m.state = 'provisional' AND a.principal_id = ${seed.approver.principal.id} AND a.access = 'owner' AND s.text = ${sentence}`))[0]);

    const noIndicator = spawnSync(binary, ['--light', 'none', '--screen', 'none'], { encoding: 'utf8' });
    assert.equal(noIndicator.status, 2, noIndicator.stderr);
    assert.match(noIndicator.stderr, /light or a screen/i);
    const light = startDevice(binary, scratch, link.origin, 'Fixture light', `file:${wav}`, 'none');
    devices.push(light);
    const lightCode = await until('light authorization response', () => link.codes[0]);
    assert.match(lightCode, /^\d{4}-\d{4}$/);
    await checkBlinks(light.rows, lightCode);
    assert.equal(speech.streams.length, 0, 'no capture before approval');
    const approved = await fetch(`${origin}/api/v1/device/approve`, { method: 'POST', headers: sessionHeaders(seed.session), body: JSON.stringify({ user_code: lightCode, approve: true }) });
    assert.equal(approved.status, 200, await approved.text());
    const lightToken = await light.credential();
    const live = await waitSpeech(0);
    checkFirstAudio(firstAudioIndications);
    console.log('V1: The terminal light matched the code and showed listening when the API received the first audio.');
    live.emit(result);
    const lightMeeting = await meeting(lightToken.listener_id);
    const [firstEpoch] = await query(sql<{ id: string }>`SELECT id FROM capture_epochs WHERE listener_id = ${lightToken.listener_id}`);
    const reconnectAt = speech.streams.length;
    link.disconnect();
    await delay(10_000);
    link.reconnect();
    await waitSpeech(reconnectAt);
    assert.deepEqual(await query(sql<{ id: string }>`SELECT id FROM capture_epochs WHERE listener_id = ${lightToken.listener_id}`), [firstEpoch]);
    checkReconnect(light.rows());
    assert.equal(await light.exited, 0, light.output());
    const stored = await query(sql<StoredChunk>`
      SELECT sample_start, sample_count, LOWER(HEX(sha256)) AS digest, object_key, upload_state FROM recording_chunks WHERE epoch_id = ${firstEpoch.id} ORDER BY sample_start`);
    checkArchive(stored, samples, pcm => upload(lightToken.listener_id, pcm).body, objects.objects);
    console.log(`V2, V5: Meeting ${lightMeeting.id} has a transcript. One epoch contains all ${samples.length} samples after a 10-second outage.`);

    const kiosk = await browser.newPage({ viewport: { width: 320, height: 240 } });
    const page = await sessionPage(browser, origin, seed.session);
    const other = await sessionPage(browser, origin, seed.other);
    const capture = join(scratch, 'fixture.raw');
    const pidFile = join(scratch, 'source.pid');
    const source = join(scratch, 'source.cjs');
    writeFileSync(capture, raw.subarray(44));
    writeFileSync(source, `const fs = require('node:fs'); const input = fs.readFileSync(process.argv[2]);\nfs.writeFileSync(process.argv[3], String(process.pid)); let i = 0;\nconst timer = setInterval(() => { process.stdout.write(input.subarray(i, i += 640)); if (i >= input.length) clearInterval(timer); }, 20);\n`);
    const from = speech.streams.length;
    const screen = startDevice(binary, scratch, link.origin, 'Fixture kiosk', `cmd:exec ${[process.execPath, source, capture, pidFile].map(quote).join(' ')}`, `kiosk:${join(webRoot, 'kiosk')}:7171`);
    devices.push(screen);
    const code = await until('kiosk authorization response', () => link.codes[1]);
    await kiosk.goto('http://127.0.0.1:7171/');
    await expect(kiosk.getByText(code, { exact: true })).toBeVisible();
    await screenshot(kiosk, screenshots, 'kiosk-pair-320x240.png');
    await page.goto(`${origin}/pair?code=${encodeURIComponent(code)}`);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('Fixture kiosk', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByText('Paired', { exact: true })).toBeVisible();
    const screenToken = await screen.credential();
    await expect(kiosk.getByText('listening', { exact: true })).toBeVisible();
    const canvas = kiosk.locator('canvas');
    const pixels = sha(await canvas.screenshot());
    await expect.poll(async () => sha(await canvas.screenshot())).not.toBe(pixels);
    await screenshot(kiosk, screenshots, 'kiosk-listening-320x240.png');
    (await waitSpeech(from)).emit(result);
    const kioskMeeting = await meeting(screenToken.listener_id);
    assert.notEqual(kioskMeeting.id, lightMeeting.id);
    console.log(`V3: The 320×240 kiosk paired, showed listening and moved the waveform. Meeting ${kioskMeeting.id} is provisional.`);

    const meetings = await openMeetings(page, origin);
    const reviewRows = meetings.getByRole('button', { name: /Untitled meeting/ });
    await expect(reviewRows).toHaveCount(2);
    await reviewRows.last().click();
    await meetings.getByRole('tab', { name: 'Transcript' }).click();
    await expect(meetings.getByRole('tabpanel', { name: 'Transcript' })).toContainText(sentence);
    await screenshot(page, screenshots, 'device-meeting-review.png');
    const otherMeetings = await openMeetings(other, origin);
    await expect(otherMeetings.getByText('No meetings yet.', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    const settings = await openMenu(page, 'Settings');
    await expect(settings.getByText('Fixture light', { exact: true })).toBeVisible();
    await expect(settings.getByText('Fixture kiosk', { exact: true })).toBeVisible();
    console.log('V4: Browser approval and device settings worked. The other member did not see either meeting.');

    const pid = Number(readFileSync(pidFile, 'utf8'));
    const sourceProcess = `/proc/${pid}`;
    assert(existsSync(sourceProcess), 'the PCM source is open before revocation');
    const revokedAt = performance.now();
    const revoked = await fetch(`${origin}/api/v1/devices/${screenToken.device_id}`, { method: 'DELETE', headers: sessionHeaders(seed.session) });
    assert.equal(revoked.status, 204, await revoked.text());
    await until('revoked device shows unpaired', () => {
      const rows = screen.rows();
      return rows.slice(rows.findIndex(row => row.state === 'listening') + 1).find(row => row.state === 'unpaired');
    }, 20_000);
    assert(performance.now() - revokedAt <= 20_000, 'device stopped within 20 seconds');
    assert(!existsSync(sourceProcess), 'the PCM source closed before the unpaired indication');
    assert(!existsSync(screen.creds), 'revoked device removed its credential');
    const denied = await fetch(`${origin}/api/v1/listeners/${screenToken.listener_id}/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${screenToken.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ lease_generation: 0, state: 'stopped', epoch_id: null, buffered_chunks: 0, storage_bytes_free: null }) });
    assert.equal(denied.status, 401, await denied.text());
    const frames = () => speech.streams.reduce((total, stream) => total + stream.received, 0);
    const seen = frames();
    await delay(1_000);
    assert.equal(frames(), seen, 'no further live audio after revocation');
    console.log('V6: Revocation closed the PCM source, removed the token and stopped live frames.');

    await probeInvalidStart(host, lightToken.access_token);
    console.log('V7: The binary and ingest socket refused a device without an indicator.');
  } catch (error) {
    for (const device of devices) console.error(device.output().slice(-2_000));
    throw error;
  } finally {
    try {
      await stopDevices(devices, screenshots);
    } finally {
      for (const close of cleanup.reverse()) await close();
    }
  }
}

const env = childEnv(process.env);
for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
Object.assign(process.env, env);
const admin = env['SANCTUM_TEST_MYSQL_URL'];
assert(admin, 'Set SANCTUM_TEST_MYSQL_URL to a test MySQL server.');
const screenshots = env['SANCTUM_DEVICE_EVIDENCE_DIR'];
if (screenshots !== undefined) mkdirSync(screenshots, { recursive: true });
const binary = env['SANCTUM_DEVICE_BIN'] ?? join(deviceRoot, 'target/debug/sanctum-listener');
// Blaze checks this workspace but cannot emit the listener binary.
if (!env['SANCTUM_DEVICE_BIN']) build('cargo', ['build', '--locked', '-p', 'sanctum-listener'], deviceRoot);
build('npm', ['run', 'build', '-w', 'web-app'], root);
await runSuite(admin, binary, screenshots);
