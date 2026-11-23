import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { expect, layer } from '@effect/vitest';
import { CaptureEpochId, type ListenerId, Unauthenticated } from '@sanctum/contracts';
import { syntheticPcm } from '@sanctum/contracts/fixtures';
import { Effect, Layer } from 'effect';
import type * as MediaProviders from '../src/media/providers.ts';
import { vi } from 'vitest';
import { Authenticator, hashToken, KernelAuthenticatorLive, openSession, SESSION_COOKIE } from '../src/auth.ts';
import { serverLayer } from '../src/main.ts';
import { reconcileTranscript } from '../src/media/reconcile.ts';
import { meetingsOf } from './support/capture.ts';
import { seedWorkspace } from './support/fixtures.ts';
import { api, chunk, eventually, fakeSpeech, MigratedDatabase, openSocket, serveApi, uploadChunk } from './support/media.ts';
import { memoryObjectStore } from './support/object-store.ts';

const work = vi.hoisted(() => vi.fn());
// Hoisted server mocks load their Effect tags before the test module's static imports run.
vi.mock('../src/speech-requests.ts', async () => {
  const { Effect, Layer, Stream } = await import('effect');
  const { SpeechReplies, SpeechWorkRequests } = await import('../src/media/speech-gate.ts');
  return {
    SpeechRepliesLive: Layer.succeed(SpeechReplies, () => () => Stream.make('Fixture reply.')),
    SpeechWorkRequestsLive: Layer.succeed(SpeechWorkRequests, () => request => Effect.sync(() => { work(request); return false; })),
  };
});
vi.mock('../src/media/providers.ts', async importOriginal => {
  const { Layer, Stream } = await import('effect');
  const { SpeechSynthesizer } = await import('../src/providers/speech.ts');
  return {
    ...await importOriginal<typeof MediaProviders>(),
    SpeechSynthesizerLive: Layer.succeed(SpeechSynthesizer, { synthesize: () => Stream.make(Uint8Array.of(0, 0)) }),
  };
});

const RATE = 16_000;
const FRAME = 320;
const captured_at = '2026-09-26T17:00:00Z';
const lightOnly = { mic: true, screen: false, light: 'mono', speaker: false } as const;
const screenAndSpeaker = { mic: true, screen: true, light: 'none', speaker: true } as const;

// Write the hardware frame directly from the device protocol, not with the server's codec.
function hardwareFrame(sequence: number, samples: Int16Array) {
  const bytes = new Uint8Array(24 + 2 * FRAME);
  const frame = new DataView(bytes.buffer);
  frame.setUint8(0, 1);
  frame.setUint8(1, 1);
  frame.setUint32(4, sequence, true);
  frame.setBigUint64(8, BigInt(sequence * FRAME), true);
  frame.setUint32(16, FRAME, true);
  for (let index = 0; index < FRAME; index++) frame.setInt16(24 + index * 2, samples[sequence * FRAME + index]!, true);
  return bytes;
}

const setupWith = (authenticator = KernelAuthenticatorLive) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [owner] = yield* seedWorkspace('Hardware room', ['owner']);
  const { workspace_id, principal } = owner!;
  const token = randomUUID();
  const credential_id = randomUUID();
  const device_id = randomUUID();
  yield* sql`INSERT INTO agent_credentials (id, workspace_id, principal_id, owner_principal_id, token_hash, scopes, created_at)
    VALUES (${credential_id}, ${workspace_id}, ${principal.id}, ${principal.id}, ${hashToken(token)}, '["capture:ingest"]', UTC_TIMESTAMP(6))`;
  yield* sql`INSERT INTO devices (id, workspace_id, name, capabilities, device_code_hash, user_code_hash, client_address_hash, status, approved_by, credential_id, expires_at, created_at, approved_at)
    VALUES (${device_id}, ${workspace_id}, 'Fixture device', ${JSON.stringify(lightOnly)}, ${hashToken(randomUUID())}, ${hashToken(randomUUID())}, ${hashToken(randomUUID())}, 'approved',
      ${principal.id}, ${credential_id}, UTC_TIMESTAMP(6) + INTERVAL 1 DAY, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
  const speech = fakeSpeech();
  const media = Layer.merge(speech.layer, memoryObjectStore().layer);
  const host = yield* serveApi((config, _fixtureAuth, overrides) => serverLayer(config, authenticator, overrides), new Map(), media);
  const registered = yield* api(host, token, 'POST', '/listeners', { name: 'Fixture device', mode: 'room', capabilities: { fixture: true } });
  expect(registered.status).toBe(201);
  const listener_id = registered.body.id as ListenerId;
  const lease = yield* api(host, token, 'POST', `/listeners/${listener_id}/heartbeat`, {
    lease_generation: 0, state: 'starting', epoch_id: null, buffered_chunks: 0, storage_bytes_free: null,
  });
  expect(lease.body.owner).toBe(true);
  const start = {
    _tag: 'start', protocol_version: 1, listener_id, epoch_id: CaptureEpochId.make(randomUUID()), track: 0,
    clock: { sample_rate: RATE, channels: 1, encoding: 'pcm_s16le', sample_start: 0, captured_at, timezone: 'UTC' },
    lease_generation: lease.body.lease_generation as number,
  };
  const connect = openSocket(host, listener_id, token, { authorization: `Bearer ${token}` });
  const stored = sql<{ capabilities: string }>`SELECT CAST(capabilities AS CHAR) AS capabilities FROM listeners WHERE id = ${listener_id}`
    .pipe(Effect.map(rows => JSON.parse(rows[0]!.capabilities)));
  return { workspace_id, principal, device_id, token, host, start, connect, stored, speech, media };
});

const setup = setupWith();

const stop = JSON.stringify({ _tag: 'stop', reason: 'close' });
const request = 'Sanctum, send the notes.';

layer(MigratedDatabase, { timeout: 120_000 })('hardware listener ingest', it => {
  it.scoped('accepts 20 ms frames, stores the last declaration, and reconciles fifteen 2 s chunks', () =>
    Effect.gen(function* () {
      const { workspace_id, principal, token, host, start, connect, stored, speech, media } = yield* setup;
      const { listener_id, epoch_id } = start;
      const first = yield* connect;
      first.send(JSON.stringify({ ...start, capabilities: lightOnly }));
      expect(yield* first.take('accepted')).toMatchObject({ resume_from_sample: 0 });
      expect(yield* stored).toEqual({ fixture: true, device: lightOnly });
      first.close();
      yield* first.closed;

      const socket = yield* connect;
      socket.send(JSON.stringify({ ...start, capabilities: screenAndSpeaker }));
      expect(yield* socket.take('accepted')).toMatchObject({ resume_from_sample: 0 });
      expect(yield* stored).toEqual({ fixture: true, device: screenAndSpeaker });

      work.mockClear();
      const samples = syntheticPcm({ sampleRate: RATE, seconds: 30, toneHz: 440 });
      for (let sequence = 0; sequence < 50; sequence++) {
        socket.send(hardwareFrame(sequence, samples));
        expect(yield* socket.take('ack')).toMatchObject({ sequence, sample_end: (sequence + 1) * FRAME });
      }
      const stream = (yield* eventually(Effect.sync(() => speech.streams[0]), value => value?.received === RATE))!;
      stream.emitBatch({ start_s: 0, end_s: 1, settled_s: 1, results: [
        { start_s: 0, end_s: 0.2, is_final: true, text: request, confidence: 1, speaker: null },
      ] });
      expect((yield* socket.take('transcript')).segment).toMatchObject({ text: request, status: 'final' });
      const [meeting] = yield* meetingsOf(workspace_id);
      expect(meeting).toMatchObject({ state: 'provisional' });

      for (let sequence = 0; sequence < 15; sequence++) {
        const sample_start = sequence * 2 * RATE;
        const upload = chunk({ listener_id, epoch_id, sequence, sample_start, captured_at: new Date(Date.parse(captured_at) + sequence * 2_000).toISOString(), samples: samples.subarray(sample_start, sample_start + 2 * RATE) });
        expect(upload.body.byteLength).toBe(64_044);
        expect(yield* uploadChunk(host, token, upload)).toMatchObject({ status: 200, body: { sha256: upload.manifest.sha256, byte_length: 64_044 } });
      }
      socket.send(stop);
      expect((yield* socket.closed).code).toBe(1000);
      expect(socket.messages.filter(message => ['ack', 'action_update', 'speech_chunk', 'speech_cancel'].includes(message._tag))).toEqual([]);
      expect(work).not.toHaveBeenCalled();
      const payload = { epoch_id, track: 0, sample_start: 0, sample_end: samples.length };
      expect(yield* reconcileTranscript({ workspace_id, payload }).pipe(Effect.provide(media))).toMatchObject({ status: 'succeeded', result: { missing_audio: [] } });
      expect(speech.batches.reduce((total, batch) => total + batch.samples.length, 0)).toBe(samples.length - RATE);

      // A browser session for the same owner keeps spoken work and its action feed.
      const session = yield* openSession({ workspace_id, principal_id: principal.id });
      const browser = yield* openSocket(host, listener_id, token, { origin: `http://${host}`, cookie: `${SESSION_COOKIE}=${session.token}` });
      browser.send(JSON.stringify({ ...start, epoch_id: randomUUID() }));
      yield* browser.take('accepted');
      yield* browser.take('action_update');
      for (let sequence = 0; sequence < 50; sequence++) {
        browser.send(hardwareFrame(sequence, samples));
        yield* browser.take('ack');
      }
      const browserStream = (yield* eventually(Effect.sync(() => speech.streams[1]), value => value?.received === RATE))!;
      browserStream.emitBatch({ start_s: 0, end_s: 1, settled_s: 1, results: [
        { start_s: 0, end_s: 0.2, is_final: true, text: request, confidence: 1, speaker: null },
      ] });
      yield* browser.take('speech_chunk');
      expect(work).toHaveBeenCalledWith('send the notes.');
    }),
  );

  it.scoped('closes a live device socket when its owner revokes the device', () =>
    Effect.gen(function* () {
      const { workspace_id, principal, device_id, host, start, connect } = yield* setup;
      const socket = yield* connect;
      socket.send(JSON.stringify({ ...start, capabilities: lightOnly }));
      yield* socket.take('accepted');
      socket.send(hardwareFrame(0, syntheticPcm({ sampleRate: RATE, seconds: 1, toneHz: 440 })));
      yield* socket.take('ack');
      const session = yield* openSession({ workspace_id, principal_id: principal.id });
      const revoked = yield* api(host, '', 'DELETE', `/devices/${device_id}`, undefined, {
        authorization: '', cookie: `${SESSION_COOKIE}=${session.token}`, 'x-csrf-token': session.csrf_token, origin: `http://${host}`,
      });
      expect(revoked.status).toBe(204);
      expect(yield* socket.take('rejected')).toMatchObject({ reason: 'unauthorized' });
      expect((yield* socket.closed).code).toBe(1008);
    }),
  );

  it.scoped('closes a newly opened socket if its authorization is no longer current', () =>
    Effect.gen(function* () {
      let admitted = false;
      const authenticator = Layer.effect(Authenticator, Effect.map(Authenticator, service => ({
        authenticate: request => Effect.suspend(() => {
          if (request.url.endsWith('/stream')) {
            if (admitted) return Effect.fail(new Unauthenticated({ message: 'This credential was revoked' }));
            admitted = true;
          }
          return service.authenticate(request);
        }),
      }))).pipe(Layer.provide(KernelAuthenticatorLive));
      const { connect } = yield* setupWith(authenticator);
      const socket = yield* connect;
      expect(yield* socket.take('rejected')).toMatchObject({ reason: 'unauthorized' });
      expect((yield* socket.closed).code).toBe(1008);
    }),
  );

  it.scoped('rejects a missing declaration and a declaration without an indicator', () =>
    Effect.gen(function* () {
      const { start, connect, stored } = yield* setup;
      for (const capabilities of [undefined, { ...lightOnly, light: 'none' }]) {
        const socket = yield* connect;
        socket.send(JSON.stringify({ ...start, capabilities }));
        expect(yield* socket.take('rejected')).toMatchObject({ reason: 'invalid_start' });
        expect((yield* socket.closed).code).toBe(1008);
      }
      expect(yield* stored).toEqual({ fixture: true });
    }),
  );
});
