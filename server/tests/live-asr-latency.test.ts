/**
 * Live Whisper at the latency Workers AI showed in production (isolated end-to-end runs, 2026-10-09):
 * the real session and Whisper adapter against a local stand-in, with time running SPEED times faster.
 * Real timers are the point: the adapter's hedge, fetch aborts and the frame pacing all run on the
 * platform clock, which a test clock cannot drive through fetch and the socket.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { SqlClient } from '@effect/sql';
import { expect, layer } from '@effect/vitest';
import { type AccessScope, encodePcmFrame, type MeetingId } from '@sanctum/contracts';
import { Effect, Layer, Option, Redacted, Schema } from 'effect';
import { engineeringDefaults } from '../src/config.ts';
import { serverLayer } from '../src/main.ts';
import { reconcileTranscript } from '../src/media/reconcile.ts';
import { liveLimits } from '../src/media/session.ts';
import { closeMeeting, finalizeMeeting } from '../src/meetings.ts';
import { assembleRecording } from '../src/playback.ts';
import { SpeechToText, whisperSpeechToText } from '../src/providers/whisper.ts';
import { coverageIn, uncovered } from '../src/transcripts.ts';
import { claimed, jobsOf } from './support/capture.ts';
import { seedWorkspace } from './support/fixtures.ts';
import { chunk, claimListener, MigratedDatabase, newEpochId, openSocket, pause, serveApi, startMessage, uploadChunk } from './support/media.ts';
import { memoryObjectStore } from './support/object-store.ts';

const SPEED = 10;
/** Browser capture in production: 44.1 kHz in 50 ms frames. */
const RATE = 44_100;
const FRAME = 2_205;
/** Seconds per answer in production at the 20 quantiles, interleaved: 2–8 s, median about 3.7 s. */
const ANSWER_S = [1.9, 3.2, 4.7, 2.1, 3.4, 5.1, 2.4, 3.5, 5.4, 2.6, 3.8, 6.2, 2.7, 4.1, 6.5, 2.8, 4.2, 7.9, 3.1, 4.4];
const TEXT = 'we are reviewing the launch plan';

/** 300 ms words and 100 ms pauses of varying depth, so chunks cut between 1.5 s and 2.5 s as they do on speech. */
const speechAt = (i: number) =>
  i % (0.4 * RATE) < 0.3 * RATE ? Math.round(2_000 * Math.sin((i * 2 * Math.PI * 220) / RATE)) : ((Math.floor(i / (0.4 * RATE)) * 7_919) % 97) * Math.sign(Math.sin(i));

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
          const seconds = (Buffer.from(audio, 'base64').byteLength - 44) / 2 / RATE;
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
    const media = Layer.merge(memoryObjectStore().layer, Layer.succeed(SpeechToText, whisperSpeechToText({ workersAi: Option.some({ baseUrl, apiToken: Redacted.make('wai-token') }), liveAsr })));
    const tokens = new Map<string, AccessScope>();
    const host = yield* serveApi(serverLayer, tokens, media);
    const [owner] = yield* seedWorkspace('Room', ['owner']);
    tokens.set('owner', { ...owner!, scopes: [...owner!.scopes, 'capture:ingest'] });
    const { listener_id, lease_generation } = yield* claimListener(host, 'owner');
    const epoch_id = newEpochId();
    const socket = yield* openSocket(host, listener_id, 'owner');
    socket.send(startMessage({ listener_id, epoch_id, lease_generation, sample_rate: RATE }));
    yield* socket.take('accepted');
    return { host, owner: owner!, media, listener_id, epoch_id, socket };
  });

/** Streams `seconds` of speech as the browser does, then stops and waits until the server flushed live answers and closed. */
const speak = (socket: { readonly send: (data: string | Uint8Array) => void; readonly closed: Effect.Effect<unknown> }, seconds: number) =>
  Effect.gen(function* () {
    const started = Date.now();
    for (let sequence = 0; sequence * FRAME < seconds * RATE; sequence++) {
      const wait = started + (sequence * 50) / SPEED - Date.now();
      if (wait > 0) yield* pause(wait);
      const samples = Int16Array.from({ length: FRAME }, (_, i) => speechAt(sequence * FRAME + i));
      socket.send(encodePcmFrame({ track: 0, sequence, sample_start: sequence * FRAME, sample_count: FRAME }, samples));
    }
    socket.send(JSON.stringify({ _tag: 'stop', reason: 'pause' }));
    yield* socket.closed;
    return Math.ceil((seconds * RATE) / FRAME) * FRAME;
  });

layer(MigratedDatabase, { timeout: 120_000 })('live ASR at production Workers AI latency', it => {
  it.scoped(
    'keeps up with 150 s of continuous speech through a 12.6 s answer and an unanswered request',
    () =>
      Effect.gen(function* () {
        liveLimits.providerRetryMs = 5_000 / SPEED;
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
        liveLimits.providerRetryMs = 5_000 / SPEED;
        // Normal answers open the meeting; from the sixth request on, answers take 80 s until the provider recovers.
        let recovered = false;
        const provider = yield* standIn(order => (recovered || order < 5 ? ANSWER_S[order % ANSWER_S.length]! : 80));
        const { host, owner, media, listener_id, epoch_id, socket } = yield* listen(provider.baseUrl);
        const end = yield* speak(socket, 60);
        expect(socket.messages).toContainEqual(expect.objectContaining({ _tag: 'degraded', reason: 'asr_backlog' }));

        // The browser uploads the archive in 30 s chunks while it listens.
        for (const [sequence, sample_start] of [0, 30 * RATE].entries()) {
          const samples = Int16Array.from({ length: Math.min(30 * RATE, end - sample_start) }, (_, i) => speechAt(sample_start + i));
          expect((yield* uploadChunk(host, 'owner', chunk({ listener_id, epoch_id, sequence, sample_start, samples, sample_rate: RATE }))).status).toBe(200);
        }
        const [meeting] = yield* sql<{ id: MeetingId }>`SELECT id FROM meetings WHERE listener_id = ${listener_id}`;
        const job = (kind: 'meeting.finalize' | 'recording.assemble') => claimed(owner.workspace_id, kind, { meeting_id: meeting!.id });
        yield* closeMeeting(owner, meeting!.id);
        expect((yield* finalizeMeeting(job('meeting.finalize'))).result).toMatchObject({ processing: { transcript: 'partial' } });
        yield* Effect.provide(assembleRecording(job('recording.assemble')), media);
        // The worker finished the close's finalize before reconciliation ran.
        yield* sql`UPDATE jobs SET status = 'succeeded' WHERE workspace_id = ${owner.workspace_id} AND kind = 'meeting.finalize'`;

        recovered = true;
        for (const sample_start of [0, 30 * RATE]) {
          const payload = { epoch_id, track: 0, sample_start, sample_end: Math.min(sample_start + 30 * RATE, end) };
          yield* Effect.provide(reconcileTranscript({ workspace_id: owner.workspace_id, payload }), media);
        }
        const pending = (yield* jobsOf(owner.workspace_id)).filter(row => row.kind === 'meeting.finalize' && row.status === 'pending');
        expect(pending).toEqual([{ kind: 'meeting.finalize', work_key: `meeting:${meeting!.id}`, status: 'pending' }]);
        expect((yield* finalizeMeeting(job('meeting.finalize'))).result).toMatchObject({ processing: { transcript: 'complete' } });
        yield* Effect.provide(assembleRecording(job('recording.assemble')), media);
        const [processing] = yield* sql<{ recording: string }>`SELECT processing->>'$.recording' AS recording FROM meetings WHERE id = ${meeting!.id}`;
        expect(processing).toEqual({ recording: 'complete' });
      }),
    60_000,
  );
});
