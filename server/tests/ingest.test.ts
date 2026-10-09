import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { beforeAll, expect, layer } from '@effect/vitest';
import type { AccessScope, CaptureEpochId, MeetingId } from '@sanctum/contracts';
import { syntheticPcm } from '@sanctum/contracts/fixtures';
import { Effect, Layer } from 'effect';
import { reconcileTranscript } from '../src/media/reconcile.ts';
import { liveLimits } from '../src/media/session.ts';
import { finalSegments } from '../src/transcripts.ts';
import {
  chunk,
  claimListener,
  eventually,
  fakeSpeech,
  MigratedDatabase,
  newEpochId,
  openSocket,
  pause,
  pcmFrame,
  uploadChunk,
  seedDevice,
  serveApi,
  startMessage,
} from './support/media.ts';
import { serverLayer } from '../src/main.ts';
import { memoryObjectStore } from './support/object-store.ts';
import { seedWorkspace } from './support/fixtures.ts';

const RATE = 16_000;

beforeAll(() => {
  liveLimits.providerRetryMs = 200;
  liveLimits.actionFeedMs = 100;
});

/** Server with fake providers, a claimed listener and a started live session. */
const setup = Effect.gen(function* () {
  const tokens = new Map<string, AccessScope>();
  const speech = fakeSpeech();
  const store = memoryObjectStore();
  const providers = Layer.merge(store.layer, speech.layer);
  const host = yield* serveApi(serverLayer, tokens, providers);
  const access = yield* seedDevice('Room A');
  tokens.set('device', access);
  const { listener_id, lease_generation } = yield* claimListener(host, 'device');
  const epoch_id = newEpochId();
  const connect = Effect.gen(function* () {
    const socket = yield* openSocket(host, listener_id, 'device');
    socket.send(startMessage({ listener_id, epoch_id, lease_generation }));
    return { socket, accepted: yield* socket.take('accepted') };
  });
  const { socket } = yield* connect;
  return { host, access, speech, store, providers, listener_id, epoch_id, socket, connect };
});

const finals = (access: AccessScope, epoch_id: CaptureEpochId) =>
  Effect.map(finalSegments(access, { epoch_id, track: 0, sample_start: 0, sample_end: 10 * RATE }), segments =>
    segments.map(segment => [segment.source.sample_start, segment.source.sample_end, segment.text, segment.origin]),
  );

layer(MigratedDatabase, { timeout: 120_000 })('live WebSocket ingest', it => {
  it.scoped('persists live finals at epoch sample positions and keeps partials provisional', () =>
    Effect.gen(function* () {
      const { access, speech, epoch_id, socket } = yield* setup;
      for (let sequence = 0; sequence < 3; sequence++) socket.send(pcmFrame(sequence, sequence * 1_600));
      const stream = yield* eventually(Effect.sync(() => speech.streams[0]), stream => stream?.received === 4_800);
      expect(stream!.sample_rate).toBe(RATE);

      stream!.emit({ start_s: 0, end_s: 0.1, is_final: false, text: 'hel', confidence: 0.4, speaker: '0' });
      expect((yield* socket.take('transcript')).segment).toMatchObject({ status: 'partial', text: 'hel', source: { epoch_id, sample_start: 0, sample_end: 1_600 } });
      expect(yield* finals(access, epoch_id)).toEqual([]);

      stream!.emit({ start_s: 0.2, end_s: 0.3, is_final: true, text: 'world', confidence: 0.9, speaker: '0' });
      stream!.emit({ start_s: 0, end_s: 0.1, is_final: true, text: 'hello', confidence: 0.9, speaker: '0' });
      stream!.emit({ start_s: 0, end_s: 0.1, is_final: true, text: 'hello', confidence: 0.9, speaker: '0' });
      const persisted = yield* eventually(finals(access, epoch_id), rows => rows.length === 2);
      expect(persisted).toEqual([
        [0, 1_600, 'hello', 'live'],
        [3_200, 4_800, 'world', 'live'],
      ]);
      yield* socket.take('transcript');
      yield* socket.take('transcript');
      yield* pause(200);
      expect(socket.messages.filter(message => message._tag === 'transcript')).toEqual([]);
    }),
  );

  it.scoped('maps each provider connection from its own anchor after a reconnect', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { access, speech, epoch_id, socket, connect } = yield* setup;
      socket.send(pcmFrame(0, 0));
      socket.send(pcmFrame(1, 1_600));
      yield* socket.take('ack');
      yield* socket.take('ack');
      socket.close();
      yield* eventually(Effect.sync(() => speech.streams[0]?.finished), finished => finished === true);

      const { socket: resumed, accepted } = yield* connect;
      expect(accepted.resume_from_sample).toBe(3_200);
      resumed.send(pcmFrame(2, 3_200));
      const second = yield* eventually(Effect.sync(() => speech.streams[1]), stream => stream?.received === 1_600);
      second!.emit({ start_s: 0, end_s: 0.05, is_final: true, text: 'after reconnect', confidence: 0.8, speaker: '1' });
      expect(yield* eventually(finals(access, epoch_id), rows => rows.length === 1)).toEqual([[3_200, 4_000, 'after reconnect', 'live']]);
      const anchors = yield* sql<{ anchor_sample: string; closed: number }>`
        SELECT anchor_sample, closed_at IS NOT NULL AS closed FROM provider_connections WHERE epoch_id = ${epoch_id} ORDER BY opened_at`;
      expect(anchors.map(row => [row.anchor_sample, Number(row.closed)])).toEqual([['0', 1], ['3200', 0]]);
    }),
  );

  it.scoped('degrades on a provider outage, keeps accepting audio, and recovers the range from the archive', () =>
    Effect.gen(function* () {
      const { host, access, speech, providers, listener_id, epoch_id, socket } = yield* setup;
      speech.controls.openFailures = 1;
      socket.send(pcmFrame(0, 0));
      expect(yield* socket.take('degraded')).toEqual({ _tag: 'degraded', reason: 'provider_unavailable', from_sample: 0 });
      expect(yield* socket.take('ack')).toMatchObject({ sample_end: 1_600 });

      const archived = chunk({ listener_id, epoch_id, sequence: 0, sample_start: 0, samples: syntheticPcm({ sampleRate: RATE, seconds: 1, toneHz: 440 }) });
      expect((yield* uploadChunk(host, 'device', archived)).status).toBe(200);
      yield* Effect.provide(reconcileTranscript({ workspace_id: access.workspace_id, payload: { epoch_id, track: 0, sample_start: 0, sample_end: RATE } }), providers);
      expect(yield* finals(access, epoch_id)).toEqual([[0, RATE, 'batch text', 'batch']]);

      yield* pause(250);
      socket.send(pcmFrame(1, 1_600));
      const reopened = yield* eventually(Effect.sync(() => speech.streams[0]), stream => stream?.received === 1_600);
      reopened!.emit({ start_s: 0, end_s: 0.1, is_final: true, text: 'live duplicate of archive', confidence: 0.9, speaker: null });
      yield* socket.take('ack');
      yield* pause(300);
      expect(yield* finals(access, epoch_id)).toEqual([[0, RATE, 'batch text', 'batch']]);

      reopened!.drop();
      expect(yield* socket.take('degraded')).toMatchObject({ reason: 'provider_unavailable' });
      const sql = yield* SqlClient.SqlClient;
      const closed = yield* eventually(
        sql<{ close_reason: string | null }>`SELECT close_reason FROM provider_connections WHERE epoch_id = ${epoch_id} AND purpose = 'asr'`,
        rows => rows[0]?.close_reason != null,
      );
      expect(closed).toEqual([{ close_reason: 'provider_error' }]);
      expect(reopened!.released).toBe(true);
    }),
  );

  it.scoped('records a whole live chunk as transcribed, so reconciliation does not re-send the gaps between its words', () =>
    Effect.gen(function* () {
      const { host, access, speech, providers, listener_id, epoch_id, socket } = yield* setup;
      for (let sequence = 0; sequence < 10; sequence++) socket.send(pcmFrame(sequence, sequence * 1_600));
      const stream = yield* eventually(Effect.sync(() => speech.streams[0]), stream => stream?.received === RATE);
      stream!.emitBatch({ start_s: 0, end_s: 1, results: [{ start_s: 0.2, end_s: 0.3, is_final: true, text: 'between pauses', confidence: null, speaker: null }] });
      yield* eventually(finals(access, epoch_id), rows => rows.length === 1);

      const archived = chunk({ listener_id, epoch_id, sequence: 0, sample_start: 0, samples: syntheticPcm({ sampleRate: RATE, seconds: 1, toneHz: 440 }) });
      expect((yield* uploadChunk(host, 'device', archived)).status).toBe(200);
      yield* Effect.provide(reconcileTranscript({ workspace_id: access.workspace_id, payload: { epoch_id, track: 0, sample_start: 0, sample_end: RATE } }), providers);
      expect(speech.batches).toEqual([]);
      expect(yield* finals(access, epoch_id)).toEqual([[3_200, 4_800, 'between pauses', 'live']]);
    }),
  );

  it.scoped('skips live ASR under provider backpressure instead of queueing without bound', () =>
    Effect.gen(function* () {
      const { speech, socket } = yield* setup;
      socket.send(pcmFrame(0, 0));
      const slow = yield* eventually(Effect.sync(() => speech.streams[0]), stream => stream?.received === 1_600);
      slow!.backlog = liveLimits.asrBacklogBytes;
      socket.send(pcmFrame(1, 1_600));
      expect(yield* socket.take('degraded')).toEqual({ _tag: 'degraded', reason: 'asr_backlog', from_sample: 1_600 });
      yield* socket.take('ack');
      expect(yield* socket.take('ack')).toMatchObject({ sequence: 1, sample_end: 3_200 });
      expect(slow!.received).toBe(1_600);
      yield* eventually(Effect.sync(() => slow!.finished), finished => finished);
    }),
  );

  it.scoped('rejects malformed and premature frames and trims frames straddling the watermark', () =>
    Effect.gen(function* () {
      const { host, speech, listener_id, socket, connect } = yield* setup;
      socket.send(new Uint8Array([1, 2, 3]));
      expect(yield* socket.take('rejected')).toMatchObject({ reason: 'protocol_error', message: 'Malformed frame: too_short' });
      expect((yield* socket.closed).code).toBe(1008);

      const { socket: second } = yield* connect;
      second.send(pcmFrame(0, 0));
      second.send(pcmFrame(1, 800));
      yield* second.take('ack');
      expect(yield* second.take('ack')).toMatchObject({ sequence: 1, sample_end: 2_400 });
      yield* eventually(Effect.sync(() => speech.streams[0]?.received), received => received === 2_400);

      const premature = yield* openSocket(host, listener_id, 'device');
      premature.send(pcmFrame(0, 0));
      expect(yield* premature.take('rejected')).toMatchObject({ reason: 'invalid_start' });
    }),
  );

  it.scoped("streams the listener's meeting actions with readable titles: snapshot, changes from any process, snapshot again on reconnect", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tokens = new Map<string, AccessScope>();
      const host = yield* serveApi(serverLayer, tokens, Layer.merge(memoryObjectStore().layer, fakeSpeech().layer));
      const [owner] = yield* seedWorkspace('Feed room', ['owner']);
      tokens.set('owner', { ...owner!, scopes: [...owner!.scopes, 'capture:ingest'] });
      const { listener_id, lease_generation } = yield* claimListener(host, 'owner');
      const meeting_id = randomUUID() as MeetingId;
      yield* sql`INSERT INTO meetings (id, workspace_id, listener_id, state, visibility, timezone, started_at, processing, created_at, updated_at)
        VALUES (${meeting_id}, ${owner!.workspace_id}, ${listener_id}, 'active', 'workspace', 'UTC', UTC_TIMESTAMP(6),
          ${JSON.stringify({ transcript: 'pending', notes: 'pending', memory: 'pending', recording: 'pending' })}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
      const addAction = (id: string, action_key: string, title: string | null, age: number) =>
        sql`INSERT INTO actions (id, workspace_id, meeting_id, requested_by, action_key, idempotency_key, args, args_sha256, version, state, title, created_at, updated_at)
          VALUES (${id}, ${owner!.workspace_id}, ${meeting_id}, ${owner!.principal.id}, ${action_key}, ${id}, '{}', ${Buffer.alloc(32)}, '1', 'queued', ${title},
            UTC_TIMESTAMP(6) - INTERVAL ${age} SECOND, UTC_TIMESTAMP(6))`;
      const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
      yield* addAction(first, 'gmail-send-email', null, 30);
      yield* addAction(second, 'google_calendar-create-event', 'Book the rollout review', 20);
      const epoch_id = newEpochId();
      const connect = Effect.gen(function* () {
        const socket = yield* openSocket(host, listener_id, 'owner');
        socket.send(startMessage({ listener_id, epoch_id, lease_generation }));
        yield* socket.take('accepted');
        return socket;
      });
      const socket = yield* connect;
      expect(yield* socket.take('action_update')).toEqual({
        _tag: 'action_update',
        meeting_id,
        actions: [
          { action_id: first, action_key: 'gmail-send-email', state: 'queued', title: 'Gmail: send email' },
          { action_id: second, action_key: 'google_calendar-create-event', state: 'queued', title: 'Book the rollout review' },
        ],
      });

      // The job worker changes states in its own process; the socket learns of it from the database.
      yield* sql`UPDATE actions SET state = 'succeeded', updated_at = UTC_TIMESTAMP(6) WHERE id = ${second}`;
      expect(yield* socket.take('action_update')).toEqual({
        _tag: 'action_update',
        meeting_id,
        actions: [{ action_id: second, action_key: 'google_calendar-create-event', state: 'succeeded', title: 'Book the rollout review' }],
      });

      socket.close();
      yield* socket.closed;
      yield* addAction(third, 'slack-send-message', 'Post the latency numbers', 10);
      const again = yield* connect;
      expect((yield* again.take('action_update')).actions.map(action => [action.action_id, action.state, action.title])).toEqual([
        [first, 'queued', 'Gmail: send email'],
        [second, 'succeeded', 'Book the rollout review'],
        [third, 'queued', 'Post the latency numbers'],
      ]);

      yield* sql`UPDATE meetings SET state = 'closed', ended_at = UTC_TIMESTAMP(6) WHERE id = ${meeting_id}`;
      expect(yield* again.take('action_update')).toEqual({ _tag: 'action_update', meeting_id: null, actions: [] });
    }),
  );
});
