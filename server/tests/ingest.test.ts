import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { SqlClient } from '@effect/sql';
import { beforeAll, expect, layer } from '@effect/vitest';
import { type AccessScope, type CaptureEpochId, encodePcmFrame, type MeetingId } from '@sanctum/contracts';
import { syntheticPcm } from '@sanctum/contracts/fixtures';
import { Effect, Layer, Schema } from 'effect';
import { engineeringDefaults } from '../src/config.ts';
import { reconcileTranscript } from '../src/media/reconcile.ts';
import { liveLimits } from '../src/media/session.ts';
import { coverageIn, finalSegments, uncovered } from '../src/transcripts.ts';
import { deleteWorkspace } from '../src/workspaces.ts';
import {
  chunk,
  api,
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
  workersAiWhisper,
} from './support/media.ts';
import { serverLayer } from '../src/main.ts';
import { finalizeSealed, jobsOf, meetingsOf, rangesOf } from './support/capture.ts';
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
  return { host, tokens, access, speech, store, providers, listener_id, epoch_id, socket, connect };
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

  it.scoped('End meeting before the stop arrives: finals the stop flushes join the closed meeting, never a new one', () =>
    Effect.gen(function* () {
      const { host, tokens, access, speech, epoch_id, socket } = yield* setup;
      for (let sequence = 0; sequence < 3; sequence++) socket.send(pcmFrame(sequence, sequence * 1_600));
      const stream = yield* eventually(Effect.sync(() => speech.streams[0]), stream => stream?.received === 4_800);
      stream!.emit({ start_s: 0, end_s: 0.1, is_final: true, text: 'we should review the budget numbers today', confidence: 0.9, speaker: '0' });
      const [meeting] = yield* eventually(meetingsOf(access.workspace_id), rows => rows.length === 1);
      // The End lands first and seals at the lagging watermark; it fences the 6 frames the page captured, and the stop still arrives after it.
      tokens.set('ender', { ...access, scopes: ['context:write'] });
      expect((yield* api(host, 'ender', 'POST', `/meetings/${meeting!.id}/end`, { epoch_id, fence_sample: 9_600 })).body).toMatchObject({ state: 'closing' });
      for (let sequence = 3; sequence < 6; sequence++) socket.send(pcmFrame(sequence, sequence * 1_600));
      stream!.pending.push({ start_s: 0.4, end_s: 0.6, is_final: true, text: 'Alice will fish the billing report', confidence: 0.9, speaker: '0' });
      socket.send(JSON.stringify({ _tag: 'stop', reason: 'pause' }));
      expect(yield* socket.closed).toMatchObject({ code: 1000, reason: 'stopped' });
      expect((yield* finals(access, epoch_id)).at(-1)).toEqual([6_400, 9_600, 'Alice will fish the billing report', 'live']);
      expect((yield* meetingsOf(access.workspace_id)).map(row => row.state)).toEqual(['closing']);
      expect(yield* rangesOf(meeting!.id)).toEqual([{ epoch_id, sample_start: 0, sample_end: 9_600 }]);
    }),
  );

  it.scoped('closes an open listener socket when its workspace is deleted, and leaves other workspaces connected', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { access, socket } = yield* setup;
      const other = yield* setup;
      socket.send(pcmFrame(0, 0));
      yield* socket.take('ack');
      const [row] = yield* sql<{ name: string }>`SELECT name FROM workspaces WHERE id = ${access.workspace_id}`;
      yield* deleteWorkspace(access, row!.name);

      expect(yield* socket.take('rejected')).toMatchObject({ reason: 'unauthorized' });
      expect(yield* socket.closed).toEqual({ code: 1008, reason: 'unauthorized' });
      other.socket.send(pcmFrame(0, 0));
      expect(yield* other.socket.take('ack')).toMatchObject({ sample_end: 1_600 });
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

const SPEED = 10;
/** Browser capture in production: 44.1 kHz in 50 ms frames. */
const BROWSER_RATE = 44_100;
const FRAME = 2_205;
/** Seconds per answer in production at the 20 quantiles, interleaved: 2–8 s, median about 3.7 s. */
const ANSWER_S = [1.9, 3.2, 4.7, 2.1, 3.4, 5.1, 2.4, 3.5, 5.4, 2.6, 3.8, 6.2, 2.7, 4.1, 6.5, 2.8, 4.2, 7.9, 3.1, 4.4];
const TEXT = 'we are reviewing the launch plan';

/** 300 ms words and 100 ms pauses of varying depth, so chunks cut between 1.5 s and 2.5 s as they do on speech. */
const speechAt = (i: number) =>
  i % (0.4 * BROWSER_RATE) < 0.3 * BROWSER_RATE ? Math.round(2_000 * Math.sin((i * 2 * Math.PI * 220) / BROWSER_RATE)) : ((Math.floor(i / (0.4 * BROWSER_RATE)) * 7_919) % 97) * Math.sign(Math.sin(i));

/** Provider retries at production's 5 s, scaled with the clock, until the test's scope closes. */
const slowRetries = Effect.gen(function* () {
  const before = liveLimits.providerRetryMs;
  liveLimits.providerRetryMs = 5_000 / SPEED;
  yield* Effect.addFinalizer(() => Effect.sync(() => void (liveLimits.providerRetryMs = before)));
});

const WhisperRequest = Schema.parseJson(Schema.Struct({ audio: Schema.String }));

/** Local Workers AI: answers each request after `answerS(order, repeat)` simulated seconds with one segment over its audio, or never (`null`). */
const standIn = (answerS: (order: number, repeat: boolean) => number | null) =>
  Effect.acquireRelease(
    Effect.async<{ readonly baseUrl: string; readonly server: Server }>(resume => {
      const seen = new Set<string>();
      let order = 0;
      const server = createServer((request, response) => {
        const parts: Array<Buffer> = [];
        request.on('data', part => parts.push(part));
        request.on('end', () => {
          const { audio } = Schema.decodeUnknownSync(WhisperRequest)(Buffer.concat(parts).toString());
          const seconds = (Buffer.from(audio, 'base64').byteLength - 44) / 2 / BROWSER_RATE;
          const key = createHash('sha256').update(audio).digest('hex');
          const answer = answerS(order++, seen.has(key));
          seen.add(key);
          if (answer === null) return;
          const body = JSON.stringify({ result: { text: TEXT, segments: [{ start: 0, end: seconds, text: TEXT, no_speech_prob: 0 }] } });
          setTimeout(() => response.writeHead(200, { 'content-type': 'application/json' }).end(body), (answer * 1000) / SPEED);
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resume(Effect.succeed({ baseUrl: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/accounts/acct/ai`, server }));
      });
    }),
    ({ server }) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );

/** A signed-in owner listening at 44.1 kHz in the browser, through the real Whisper adapter pointed at `baseUrl`. */
const listen = (baseUrl: string) =>
  Effect.gen(function* () {
    const liveAsr = { ...engineeringDefaults.liveAsr, hedgeMs: engineeringDefaults.liveAsr.hedgeMs / SPEED };
    const media = Layer.merge(memoryObjectStore().layer, workersAiWhisper(baseUrl, liveAsr));
    const tokens = new Map<string, AccessScope>();
    const host = yield* serveApi(serverLayer, tokens, media);
    const [owner] = yield* seedWorkspace('Room', ['owner']);
    tokens.set('owner', { ...owner!, scopes: [...owner!.scopes, 'capture:ingest'] });
    const { listener_id, lease_generation } = yield* claimListener(host, 'owner');
    const epoch_id = newEpochId();
    const socket = yield* openSocket(host, listener_id, 'owner');
    socket.send(startMessage({ listener_id, epoch_id, lease_generation, sample_rate: BROWSER_RATE }));
    yield* socket.take('accepted');
    return { host, owner: owner!, media, listener_id, epoch_id, socket };
  });

/** Streams `seconds` of speech as the browser does, then stops and waits until the server flushed live answers and closed. */
const speak = (socket: { readonly send: (data: string | Uint8Array) => void; readonly closed: Effect.Effect<unknown> }, seconds: number) =>
  Effect.gen(function* () {
    const started = Date.now();
    for (let sequence = 0; sequence * FRAME < seconds * BROWSER_RATE; sequence++) {
      const wait = started + (sequence * 50) / SPEED - Date.now();
      if (wait > 0) yield* pause(wait);
      const samples = Int16Array.from({ length: FRAME }, (_, i) => speechAt(sequence * FRAME + i));
      socket.send(encodePcmFrame({ track: 0, sequence, sample_start: sequence * FRAME, sample_count: FRAME }, samples));
    }
    socket.send(JSON.stringify({ _tag: 'stop', reason: 'pause' }));
    yield* socket.closed;
    return Math.ceil((seconds * BROWSER_RATE) / FRAME) * FRAME;
  });

layer(MigratedDatabase, { timeout: 120_000 })('live ASR at production Workers AI latency', it => {
  it.scoped(
    'keeps up with 150 s of continuous speech through a 12.6 s answer and an unanswered request',
    () =>
      Effect.gen(function* () {
        yield* slowRetries;
        // The two slow answers production showed: one after 12.6 s, one never (still pending after 17.8 s); a second send gets a slow-normal answer.
        let straggled = false;
        let hung = false;
        const provider = yield* standIn((order, repeat) => {
          if (repeat) return 6.2;
          if (order >= 20 && !straggled) {
            straggled = true;
            return 12.6;
          }
          if (order >= 45 && !hung) {
            hung = true;
            return null;
          }
          return ANSWER_S[order % ANSWER_S.length]!;
        });
        const { owner, epoch_id, socket } = yield* listen(provider.baseUrl);
        const end = yield* speak(socket, 150);

        expect(socket.messages.filter(message => message._tag === 'degraded')).toEqual([]);
        const all = { sample_start: 0, sample_end: end };
        expect(uncovered(all, yield* coverageIn(owner.workspace_id, epoch_id, 0, all))).toEqual([]);
      }),
    60_000,
  );

  it.scoped(
    'reports a provider too slow for live speech, and the closed meeting reaches a complete transcript from batch',
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* slowRetries;
        // Normal answers open the meeting; from the sixth request on, answers take 80 s until the provider recovers.
        let recovered = false;
        const provider = yield* standIn(order => (recovered || order < 5 ? ANSWER_S[order % ANSWER_S.length]! : 80));
        const { host, owner, media, listener_id, epoch_id, socket } = yield* listen(provider.baseUrl);
        const end = yield* speak(socket, 60);
        expect(socket.messages).toContainEqual(expect.objectContaining({ _tag: 'degraded', reason: 'asr_backlog' }));

        // The browser uploads the archive in 30 s chunks while it listens.
        for (const [sequence, sample_start] of [0, 30 * BROWSER_RATE].entries()) {
          const samples = Int16Array.from({ length: Math.min(30 * BROWSER_RATE, end - sample_start) }, (_, i) => speechAt(sample_start + i));
          expect((yield* uploadChunk(host, 'owner', chunk({ listener_id, epoch_id, sequence, sample_start, samples, sample_rate: BROWSER_RATE }))).status).toBe(200);
        }
        const [meeting] = yield* sql<{ id: MeetingId }>`SELECT id FROM meetings WHERE listener_id = ${listener_id}`;
        expect((yield* api(host, 'owner', 'POST', `/meetings/${meeting!.id}/close`)).status).toBe(200);
        expect(yield* finalizeSealed(owner.workspace_id, meeting!.id)).toMatchObject({ processing: { transcript: 'partial' } });
        // The worker finished the close's finalize before reconciliation ran.
        yield* sql`UPDATE jobs SET status = 'succeeded' WHERE workspace_id = ${owner.workspace_id} AND kind = 'meeting.finalize'`;

        recovered = true;
        for (const sample_start of [0, 30 * BROWSER_RATE]) {
          const payload = { epoch_id, track: 0, sample_start, sample_end: Math.min(sample_start + 30 * BROWSER_RATE, end) };
          yield* Effect.provide(reconcileTranscript({ workspace_id: owner.workspace_id, payload }), media);
        }
        const pending = (yield* jobsOf(owner.workspace_id)).filter(row => row.kind === 'meeting.finalize' && row.status === 'pending');
        expect(pending).toEqual([{ kind: 'meeting.finalize', work_key: `meeting:${meeting!.id}`, status: 'pending' }]);
        expect(yield* finalizeSealed(owner.workspace_id, meeting!.id)).toMatchObject({ processing: { transcript: 'complete' } });
      }),
    60_000,
  );
});
