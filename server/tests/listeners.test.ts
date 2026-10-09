import { SqlClient } from '@effect/sql';
import { expect, layer } from '@effect/vitest';
import { type AccessScope, CaptureEpochId } from '@sanctum/contracts';
import { Clock, Effect, Layer } from 'effect';
import { runWorker } from '../src/job-runner.ts';
import type { JobHandlers } from '../src/job-types.ts';
import { hear, jobsOf, meetingsOf } from './support/capture.ts';
import { seedWorkspace } from './support/fixtures.ts';
import {
  api,
  claimListener,
  eventually,
  fakeSpeech,
  MigratedDatabase,
  chunk,
  newEpochId,
  openSocket,
  pause,
  pcmFrame,
  seedDevice,
  serveApi,
  startMessage,
  upgradeStatus,
  uploadChunk,
} from './support/media.ts';
import { serverLayer } from '../src/main.ts';
import { memoryObjectStore } from './support/object-store.ts';

const heartbeatBody = (lease_generation: number) => ({ lease_generation, state: 'listening', epoch_id: null, buffered_chunks: 0, storage_bytes_free: 1_000_000 });

const setup = Effect.gen(function* () {
  const tokens = new Map<string, AccessScope>();
  const speech = fakeSpeech();
  const host = yield* serveApi(serverLayer, tokens, Layer.merge(memoryObjectStore().layer, speech.layer));
  tokens.set('device', yield* seedDevice('Room A'));
  return { tokens, speech, host };
});

const epochRow = (epoch_id: string) =>
  Effect.flatMap(SqlClient.SqlClient, sql => sql<{ live_sample_end: string; end_reason: string | null }>`SELECT live_sample_end, end_reason FROM capture_epochs WHERE id = ${epoch_id}`);

/** Starts a live epoch captured now (a meeting it opens is not idle), streams 4 800 samples and drops the socket without a `stop`, as a killed browser would. */
const streamThenDrop = (host: string, listener_id: string, lease_generation: number) =>
  Effect.gen(function* () {
    const epoch_id = newEpochId();
    const socket = yield* openSocket(host, listener_id, 'device');
    socket.send(startMessage({ listener_id, epoch_id, lease_generation, captured_at: new Date().toISOString() }));
    yield* socket.take('accepted');
    for (let sequence = 0; sequence < 3; sequence++) socket.send(pcmFrame(sequence, sequence * 1_600));
    for (let sequence = 0; sequence < 3; sequence++) yield* socket.take('ack');
    socket.close();
    yield* eventually(epochRow(epoch_id), rows => rows[0]?.live_sample_end === '4800');
    return epoch_id;
  });

layer(MigratedDatabase, { timeout: 120_000 })('listener registration and ownership', it => {
  it.scoped('registers listeners only for principals holding capture:ingest', () =>
    Effect.gen(function* () {
      const { tokens, host } = yield* setup;
      const [member] = yield* seedWorkspace('Office', ['member']);
      tokens.set('member', member!);
      const created = yield* api(host, 'device', 'POST', '/listeners', { name: 'Room A', mode: 'room', capabilities: { audioWorklet: true } });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ workspace_id: tokens.get('device')!.workspace_id, state: 'stopped', lease_generation: 0, current_epoch_id: null });
      expect((yield* api(host, 'member', 'POST', '/listeners', { name: 'Laptop', mode: 'laptop', capabilities: {} })).status).toBe(403);
      expect((yield* api(host, 'nobody', 'POST', '/listeners', { name: 'Laptop', mode: 'laptop', capabilities: {} })).status).toBe(401);
    }),
  );

  it.scoped('refuses unauthorized upgrades before a socket exists', () =>
    Effect.gen(function* () {
      const { tokens, host } = yield* setup;
      tokens.set('other', yield* seedDevice('Room B'));
      const { listener_id } = yield* claimListener(host, 'device');
      const path = `/api/v1/listeners/${listener_id}/stream`;
      expect(yield* upgradeStatus(host, path, {})).toBe(401);
      expect(yield* upgradeStatus(host, path, { authorization: 'Bearer device', origin: 'https://attacker.test' })).toBe(403);
      expect(yield* upgradeStatus(host, path, { authorization: 'Bearer other', origin: `http://${host}` })).toBe(404);
      expect(yield* upgradeStatus(host, '/api/v1/listeners/not-a-uuid/stream', { authorization: 'Bearer device' })).toBe(404);
      expect(yield* upgradeStatus(host, path, { authorization: 'Bearer device', origin: `http://${host}` })).toBe(101);
    }),
  );

  it.scoped('fences a stale owner after another tab takes over a lapsed lease', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { host } = yield* setup;
      const { listener_id, lease_generation } = yield* claimListener(host, 'device');
      expect(lease_generation).toBe(1);
      const secondTab = yield* api(host, 'device', 'POST', `/listeners/${listener_id}/heartbeat`, heartbeatBody(0));
      expect(secondTab.body).toMatchObject({ owner: false, lease_generation: 0 });

      const epoch_id = newEpochId();
      const socket = yield* openSocket(host, listener_id, 'device');
      socket.send(startMessage({ listener_id, epoch_id, lease_generation }));
      yield* socket.take('accepted');

      yield* sql`UPDATE listeners SET lease_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ${listener_id}`;
      const takeover = yield* api(host, 'device', 'POST', `/listeners/${listener_id}/heartbeat`, heartbeatBody(0));
      expect(takeover.body).toMatchObject({ owner: true, lease_generation: 2 });
      expect((yield* epochRow(epoch_id))[0]!.end_reason).toBe('interrupted');

      socket.send(pcmFrame(0, 0));
      expect(yield* socket.take('rejected')).toMatchObject({ reason: 'stale_generation' });
      expect((yield* socket.closed).code).toBe(1008);
      expect((yield* api(host, 'device', 'POST', `/listeners/${listener_id}/heartbeat`, heartbeatBody(1))).body.owner).toBe(false);

      const stale = yield* openSocket(host, listener_id, 'device');
      stale.send(startMessage({ listener_id, epoch_id: newEpochId(), lease_generation: 1 }));
      expect(yield* stale.take('rejected')).toMatchObject({ reason: 'stale_generation' });
    }),
  );

  it.scoped('rejects a second holder of the listener and leaves the winner live segment untouched', () =>
    Effect.gen(function* () {
      const { host } = yield* setup;
      const { listener_id, lease_generation } = yield* claimListener(host, 'device');
      const epoch_id = newEpochId();
      const winner = yield* openSocket(host, listener_id, 'device');
      winner.send(startMessage({ listener_id, epoch_id, lease_generation }));
      yield* winner.take('accepted');

      // The loser keeps its own generation: the holder's is never handed out.
      const loser = yield* api(host, 'device', 'POST', `/listeners/${listener_id}/heartbeat`, heartbeatBody(0));
      expect(loser.body).toMatchObject({ owner: false, lease_generation: 0 });
      for (const start of [{ lease_generation: 0 }, { lease_generation: 0, archive_only: true }]) {
        const socket = yield* openSocket(host, listener_id, 'device');
        socket.send(startMessage({ listener_id, epoch_id: newEpochId(), ...start }));
        expect(yield* socket.take('rejected')).toMatchObject({ reason: 'stale_generation' });
      }

      winner.send(pcmFrame(0, 0));
      expect(yield* winner.take('ack')).toMatchObject({ sample_end: 1_600 });
      expect((yield* epochRow(epoch_id))[0]).toMatchObject({ end_reason: null });
    }),
  );

  it.scoped('uploads archive audio recorded under the held generation and refuses audio recorded after losing it', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { host } = yield* setup;
      const { listener_id, lease_generation } = yield* claimListener(host, 'device');
      const held = new Date(Date.now() - 60_000).toISOString();
      yield* sql`UPDATE listeners SET lease_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ${listener_id}`;
      expect((yield* api(host, 'device', 'POST', `/listeners/${listener_id}/heartbeat`, heartbeatBody(0))).body).toMatchObject({ owner: true, lease_generation: 2 });
      yield* pause(20);
      const lost = new Date().toISOString();

      const register = <T extends 'accepted' | 'rejected'>(epoch_id: CaptureEpochId, captured_at: string, verdict: T) =>
        Effect.gen(function* () {
          const socket = yield* openSocket(host, listener_id, 'device');
          socket.send(startMessage({ listener_id, epoch_id, lease_generation, archive_only: true, captured_at, end_reason: 'pause' }));
          return yield* socket.take(verdict);
        });
      const before = newEpochId();
      yield* register(before, held, 'accepted');
      expect((yield* epochRow(before))[0]).toMatchObject({ end_reason: 'pause' });
      const samples = new Int16Array(16_000);
      const put = (captured_at: string, sequence: number) =>
        uploadChunk(host, 'device', chunk({ listener_id, epoch_id: before, sequence, sample_start: sequence * 16_000, samples, captured_at }));
      expect((yield* put(held, 0)).status).toBe(200);
      expect((yield* put(lost, 1)).status).toBe(404);
      expect(yield* register(newEpochId(), lost, 'rejected')).toMatchObject({ reason: 'stale_generation' });
    }),
  );

  it.scoped('resumes the same epoch at its live watermark after a reconnect', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { host, speech } = yield* setup;
      const { listener_id, lease_generation } = yield* claimListener(host, 'device');
      const epoch_id = newEpochId();
      const first = yield* openSocket(host, listener_id, 'device');
      first.send(startMessage({ listener_id, epoch_id, lease_generation }));
      expect(yield* first.take('accepted')).toMatchObject({ epoch_id, resume_from_sample: 0 });
      for (let sequence = 0; sequence < 3; sequence++) first.send(pcmFrame(sequence, sequence * 1_600));
      expect(yield* first.take('ack')).toMatchObject({ sample_end: 1_600 });
      yield* first.take('ack');
      expect(yield* first.take('ack')).toMatchObject({ sequence: 2, sample_end: 4_800 });
      first.close();
      yield* eventually(epochRow(epoch_id), rows => rows[0]?.live_sample_end === '4800');

      const second = yield* openSocket(host, listener_id, 'device');
      second.send(startMessage({ listener_id, epoch_id, lease_generation }));
      expect(yield* second.take('accepted')).toMatchObject({ epoch_id, resume_from_sample: 4_800 });
      second.send(pcmFrame(2, 3_200));
      expect(yield* second.take('ack')).toMatchObject({ sequence: 2, sample_end: 4_800 });
      second.send(pcmFrame(3, 4_800));
      expect(yield* second.take('ack')).toMatchObject({ sequence: 3, sample_end: 6_400 });
      expect(speech.streams.map(stream => stream.received)).toEqual([4_800, 1_600]);
      const [epochs] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM capture_epochs WHERE listener_id = ${listener_id}`;
      expect(Number(epochs!.count)).toBe(1);

      const reloaded = CaptureEpochId.make(newEpochId());
      const third = yield* openSocket(host, listener_id, 'device');
      third.send(JSON.stringify({ ...JSON.parse(startMessage({ listener_id, epoch_id: reloaded, lease_generation })), start_reason: 'reload' }));
      yield* third.take('accepted');
      expect((yield* epochRow(epoch_id))[0]!.end_reason).toBe('interrupted');
      const [listener] = yield* sql<{ current_epoch_id: string }>`SELECT current_epoch_id FROM listeners WHERE id = ${listener_id}`;
      expect(listener!.current_epoch_id).toBe(reloaded);
    }),
  );

  it.scoped('registers an archive-only epoch without making it live or ending the live one', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { host } = yield* setup;
      const { listener_id, lease_generation } = yield* claimListener(host, 'device');
      const live = newEpochId();
      const socket = yield* openSocket(host, listener_id, 'device');
      socket.send(startMessage({ listener_id, epoch_id: live, lease_generation }));
      yield* socket.take('accepted');

      const offline = newEpochId();
      const archive = yield* openSocket(host, listener_id, 'device');
      archive.send(startMessage({ listener_id, epoch_id: offline, lease_generation, archive_only: true }));
      expect(yield* archive.take('accepted')).toMatchObject({ epoch_id: offline, resume_from_sample: 0 });
      expect((yield* archive.closed).code).toBe(1000);
      expect((yield* epochRow(offline))[0]!.end_reason).toBe('interrupted');
      expect((yield* epochRow(live))[0]!.end_reason).toBeNull();
      const [listener] = yield* sql<{ current_epoch_id: string }>`SELECT current_epoch_id FROM listeners WHERE id = ${listener_id}`;
      expect(listener!.current_epoch_id).toBe(live);

      const again = yield* openSocket(host, listener_id, 'device');
      again.send(startMessage({ listener_id, epoch_id: offline, lease_generation, archive_only: true }));
      yield* again.take('accepted');
      const reopen = yield* openSocket(host, listener_id, 'device');
      reopen.send(startMessage({ listener_id, epoch_id: offline, lease_generation }));
      expect(yield* reopen.take('rejected')).toMatchObject({ reason: 'epoch_closed' });
      const stale = yield* openSocket(host, listener_id, 'device');
      stale.send(startMessage({ listener_id, epoch_id: newEpochId(), lease_generation: lease_generation + 1, archive_only: true }));
      expect(yield* stale.take('rejected')).toMatchObject({ reason: 'stale_generation' });
    }),
  );

  it.scoped('ends the live epoch as interrupted when the client stops for an interruption', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { host } = yield* setup;
      const { listener_id, lease_generation } = yield* claimListener(host, 'device');
      const epoch_id = newEpochId();
      const socket = yield* openSocket(host, listener_id, 'device');
      socket.send(startMessage({ listener_id, epoch_id, lease_generation }));
      yield* socket.take('accepted');
      socket.send(JSON.stringify({ _tag: 'stop', reason: 'interrupted' }));
      expect(yield* socket.closed).toMatchObject({ code: 1000, reason: 'stopped' });
      expect((yield* epochRow(epoch_id))[0]!.end_reason).toBe('interrupted');
      const [listener] = yield* sql<{ current_epoch_id: string | null; state: string }>`SELECT current_epoch_id, state FROM listeners WHERE id = ${listener_id}`;
      expect(listener).toMatchObject({ current_epoch_id: null, state: 'stopped' });
    }),
  );

  it.scoped('resumes the epoch inside the lease; after it lapses the returning owner starts a new epoch after a gap', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { host } = yield* setup;
      const { listener_id, lease_generation } = yield* claimListener(host, 'device');
      const epoch_id = yield* streamThenDrop(host, listener_id, lease_generation);
      expect((yield* api(host, 'device', 'POST', `/listeners/${listener_id}/heartbeat`, heartbeatBody(lease_generation))).body).toMatchObject({ owner: true, lease_generation });
      const inside = yield* openSocket(host, listener_id, 'device');
      inside.send(startMessage({ listener_id, epoch_id, lease_generation }));
      expect(yield* inside.take('accepted')).toMatchObject({ epoch_id, resume_from_sample: 4_800 });
      inside.close();
      expect((yield* epochRow(epoch_id))[0]!.end_reason).toBeNull();

      yield* sql`UPDATE listeners SET lease_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ${listener_id}`;
      expect((yield* api(host, 'device', 'POST', `/listeners/${listener_id}/heartbeat`, heartbeatBody(lease_generation))).body).toMatchObject({ owner: true, lease_generation });
      expect((yield* epochRow(epoch_id))[0]!.end_reason).toBe('interrupted');
      const after = yield* openSocket(host, listener_id, 'device');
      after.send(startMessage({ listener_id, epoch_id, lease_generation }));
      expect(yield* after.take('rejected')).toMatchObject({ reason: 'epoch_closed' });
      const fresh = newEpochId();
      const next = yield* openSocket(host, listener_id, 'device');
      next.send(startMessage({ listener_id, epoch_id: fresh, lease_generation }));
      expect(yield* next.take('accepted')).toMatchObject({ epoch_id: fresh, resume_from_sample: 0 });
      const [gap] = yield* sql<{ ended_at: string | null; ordered: number }>`SELECT CAST(old.ended_at AS CHAR) AS ended_at, new.started_at >= old.ended_at AS ordered
        FROM capture_epochs old JOIN capture_epochs new ON new.id = ${fresh} WHERE old.id = ${epoch_id}`;
      expect(gap!.ended_at).not.toBeNull();
      expect(Number(gap!.ordered)).toBe(1);
      const [listener] = yield* sql<{ current_epoch_id: string }>`SELECT current_epoch_id FROM listeners WHERE id = ${listener_id}`;
      expect(listener!.current_epoch_id).toBe(fresh);
    }),
  );

  it.scoped('fences a socket still open when its lapsed lease ended the epoch', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { host } = yield* setup;
      const { listener_id, lease_generation } = yield* claimListener(host, 'device');
      const epoch_id = newEpochId();
      const socket = yield* openSocket(host, listener_id, 'device');
      socket.send(startMessage({ listener_id, epoch_id, lease_generation }));
      yield* socket.take('accepted');
      socket.send(pcmFrame(0, 0));
      yield* socket.take('ack');
      yield* eventually(epochRow(epoch_id), rows => rows[0]?.live_sample_end === '1600');

      yield* sql`UPDATE listeners SET lease_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ${listener_id}`;
      expect((yield* api(host, 'device', 'POST', `/listeners/${listener_id}/heartbeat`, heartbeatBody(lease_generation))).body).toMatchObject({ owner: true, lease_generation });
      expect((yield* epochRow(epoch_id))[0]!.end_reason).toBe('interrupted');
      socket.send(pcmFrame(1, 1_600));
      expect(yield* socket.take('rejected')).toMatchObject({ reason: 'stale_generation' });
      expect((yield* epochRow(epoch_id))[0]!.live_sample_end).toBe('1600');
    }),
  );

  it.scoped('the worker sweep interrupts a lapsed listener that never returns and seals its meeting', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { tokens, host } = yield* setup;
      const { listener_id, lease_generation } = yield* claimListener(host, 'device');
      const epoch_id = yield* streamThenDrop(host, listener_id, lease_generation);
      const device = { workspace_id: tokens.get('device')!.workspace_id, listener_id, capture_group_id: null };
      yield* hear(device, epoch_id, 0, 0.25, 'we should review the budget numbers today');
      const handlers: JobHandlers<never> = { 'context.refresh': () => Effect.succeed({ status: 'succeeded' as const, result: null }) };
      yield* Effect.forkScoped(Effect.withClock(runWorker(handlers, { pollMs: 50, concurrency: 1 }), Clock.make()));
      yield* pause(300);
      expect((yield* epochRow(epoch_id))[0]!.end_reason).toBeNull();

      yield* sql`UPDATE listeners SET lease_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ${listener_id}`;
      yield* eventually(epochRow(epoch_id), rows => rows[0]?.end_reason === 'interrupted');
      const [listener] = yield* sql<{ current_epoch_id: string | null; state: string }>`SELECT current_epoch_id, state FROM listeners WHERE id = ${listener_id}`;
      expect(listener).toMatchObject({ current_epoch_id: null, state: 'stopped' });
      const [meeting] = yield* meetingsOf(device.workspace_id);
      expect(meeting).toMatchObject({ state: 'interrupted' });
      expect(yield* jobsOf(device.workspace_id)).toContainEqual({ kind: 'meeting.finalize', work_key: `meeting:${meeting!.id}`, status: 'pending' });

      const archive = yield* openSocket(host, listener_id, 'device');
      archive.send(startMessage({ listener_id, epoch_id, lease_generation, archive_only: true, end_reason: 'close' }));
      expect(yield* archive.take('accepted')).toMatchObject({ epoch_id });
      expect((yield* epochRow(epoch_id))[0]!.end_reason).toBe('interrupted');
    }),
  );

  it.scoped('keeps two rooms independent', () =>
    Effect.gen(function* () {
      const { tokens, host } = yield* setup;
      tokens.set('roomB', yield* seedDevice('Room B'));
      const a = yield* claimListener(host, 'device', 'Room A');
      const b = yield* claimListener(host, 'roomB', 'Room B');
      const [epochA, epochB] = [newEpochId(), newEpochId()];
      const socketA = yield* openSocket(host, a.listener_id, 'device');
      const socketB = yield* openSocket(host, b.listener_id, 'roomB');
      socketA.send(startMessage({ listener_id: a.listener_id, epoch_id: epochA, lease_generation: a.lease_generation }));
      socketB.send(startMessage({ listener_id: b.listener_id, epoch_id: epochB, lease_generation: b.lease_generation }));
      yield* socketA.take('accepted');
      yield* socketB.take('accepted');
      socketA.send(pcmFrame(0, 0));
      socketA.send(pcmFrame(1, 1_600));
      socketB.send(pcmFrame(0, 0));
      yield* eventually(epochRow(epochA), rows => rows[0]?.live_sample_end === '3200');
      yield* eventually(epochRow(epochB), rows => rows[0]?.live_sample_end === '1600');

      const crossed = yield* openSocket(host, a.listener_id, 'device');
      crossed.send(startMessage({ listener_id: b.listener_id, epoch_id: epochB, lease_generation: b.lease_generation }));
      expect(yield* crossed.take('rejected')).toMatchObject({ reason: 'invalid_start' });
      expect((yield* api(host, 'device', 'POST', `/listeners/${b.listener_id}/heartbeat`, heartbeatBody(1))).status).toBe(404);
    }),
  );
});
