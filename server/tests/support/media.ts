/** Media-slice test doubles: one migrated database per suite, fake speech provider, WAV/frame builders, socket client. */
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { HttpServer } from '@effect/platform';
import {
  type AccessScope,
  CaptureEpochId,
  encodePcmFrame,
  type ListenerId,
  RecordingChunkId,
  type RecordingChunkManifest,
  type SampleRate,
  type ServerControlMessage,
  Unauthenticated,
  Unavailable,
} from '@sanctum/contracts';
import { Clock, Context, Effect, Exit, Layer, Mailbox, Schedule } from 'effect';
import { Authenticator } from '../../src/auth.ts';
import { dbLayer } from '../../src/db.ts';
import type { serverLayer } from '../../src/main.ts';
import { loadMigrations, migrate } from '../../src/migrate.ts';
import type { ObjectStore } from '../../src/providers/object-store.ts';
import { type AsrResult, SpeechToText } from '../../src/providers/deepgram.ts';
import { createTestDatabase, type TestDatabase } from './database.ts';
import { seedWorkspace } from './fixtures.ts';

class TestMysql extends Context.Tag('test/TestMysql')<TestMysql, TestDatabase['mysql']>() {}

/** One migrated database for a whole suite; tests isolate themselves with fresh workspaces. */
export const MigratedDatabase = Layer.unwrapScoped(
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
    const db = dbLayer(database.mysql);
    yield* Effect.provide(migrate(loadMigrations()), db);
    return Layer.merge(db, Layer.succeed(TestMysql, database.mysql));
  }),
);

/** A workspace whose single device member holds `capture:ingest`. */
export const seedDevice = (name: string) =>
  Effect.map(seedWorkspace(name, ['device']), ([access]): AccessScope => ({ ...access!, scopes: ['capture:ingest'] }));

/** `Authorization: Bearer <token>` resolves through `tokens`; anything else is unauthenticated. */
const tokenAuthenticator = (tokens: Map<string, AccessScope>) =>
  Layer.succeed(Authenticator, {
    authenticate: request => {
      const access = tokens.get(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
      return access === undefined ? Effect.fail(new Unauthenticated({ message: 'no credentials' })) : Effect.succeed(access);
    },
  });

interface FakeStream {
  readonly sample_rate: number;
  received: number;
  backlog: number;
  finished: boolean;
  /** The connection's scope closed (socket and keep-alive released). */
  released: boolean;
  readonly emit: (result: AsrResult) => void;
  /** The provider drops the connection unexpectedly. */
  readonly drop: () => void;
}

/** Scriptable speech provider: live streams record audio and emit what the test pushes; batch answers via `batch`. */
export function fakeSpeech() {
  const streams: Array<FakeStream> = [];
  const batches: Array<{ readonly sample_rate: number; readonly samples: Int16Array }> = [];
  const controls = {
    openFailures: 0,
    batch: (samples: Int16Array, sample_rate: number): Effect.Effect<ReadonlyArray<AsrResult>, Unavailable> =>
      Effect.succeed([{ start_s: 0, end_s: samples.length / sample_rate, is_final: true, text: 'batch text', confidence: 0.8, speaker: '0' }]),
  };
  const service = SpeechToText.of({
    provider: 'fake',
    model: 'fake-1',
    openStream: sample_rate =>
      Effect.gen(function* () {
        if (controls.openFailures > 0) {
          controls.openFailures--;
          return yield* new Unavailable({ message: 'fake provider outage', retryable: true });
        }
        const mailbox = yield* Mailbox.make<AsrResult, Unavailable>();
        const stream: FakeStream = {
          sample_rate,
          received: 0,
          backlog: 0,
          finished: false,
          released: false,
          emit: result => void mailbox.unsafeOffer(result),
          drop: () => void mailbox.unsafeDone(Exit.fail(new Unavailable({ message: 'fake provider dropped', retryable: true }))),
        };
        streams.push(stream);
        yield* Effect.addFinalizer(() => Effect.sync(() => (stream.released = true)));
        return {
          send: samples => {
            stream.received += samples.length;
            return true;
          },
          backlogBytes: () => stream.backlog,
          results: Mailbox.toStream(mailbox),
          finish: Effect.sync(() => {
            stream.finished = true;
            mailbox.unsafeDone(Exit.void);
          }),
        };
      }),
    transcribe: (sample_rate, samples) =>
      Effect.suspend(() => {
        batches.push({ sample_rate, samples: samples.slice() });
        return controls.batch(samples, sample_rate);
      }),
  });
  return { layer: Layer.succeed(SpeechToText, service), streams, batches, controls };
}

/** Canonical 44-byte-header mono PCM16 WAV. */
function wav(samples: Int16Array, sample_rate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sample_rate, true);
  view.setUint32(28, sample_rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return bytes;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A WAV chunk and its manifest for `samples` at `sample_start` of `epoch_id`. */
export function chunk(input: {
  readonly listener_id: ListenerId;
  readonly epoch_id: CaptureEpochId;
  readonly sequence: number;
  readonly sample_start: number;
  readonly samples: Int16Array;
  readonly sample_rate?: SampleRate;
}): { readonly manifest: RecordingChunkManifest; readonly body: Uint8Array } {
  const sample_rate = input.sample_rate ?? 16_000;
  const body = wav(input.samples, sample_rate);
  return {
    body,
    manifest: {
      chunk_id: RecordingChunkId.make(randomUUID()),
      listener_id: input.listener_id,
      epoch_id: input.epoch_id,
      track: 0,
      sequence: input.sequence,
      sample_start: input.sample_start,
      sample_count: input.samples.length,
      sample_rate,
      captured_at: '2026-09-26T17:00:00Z' as RecordingChunkManifest['captured_at'],
      byte_length: body.byteLength,
      sha256: sha256(body),
    },
  };
}

export const newEpochId = () => CaptureEpochId.make(randomUUID());

/** Wall clock for the server and polling: `it.scoped` otherwise installs a TestClock that never advances. */
const liveClock = Clock.make();

/** Starts the real API server (`serverLayer` from main.ts, port 0) on the suite database; resolves to `host:port`. */
export const serveApi = (server: typeof serverLayer, tokens: Map<string, AccessScope>, media: Layer.Layer<ObjectStore | SpeechToText>) =>
  Effect.gen(function* () {
    const mysql = yield* TestMysql;
    const context = yield* Effect.withClock(Layer.build(server({ apiPort: 0, mysql }, tokenAuthenticator(tokens), { media })), liveClock);
    const address = Context.get(context, HttpServer.HttpServer).address;
    if (address._tag !== 'TcpAddress') throw new Error('expected TCP');
    return `127.0.0.1:${address.port}`;
  });

/** JSON API call with a bearer token. */
export const api = (host: string, token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  Effect.promise(async () => {
    const response = await fetch(`http://${host}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body instanceof Uint8Array ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? null : body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  });

/** Uploads one archive chunk through `PUT /listeners/{id}/chunks/{chunk_id}`. */
export const uploadChunk = (host: string, token: string, upload: { readonly manifest: RecordingChunkManifest; readonly body: Uint8Array }) =>
  api(host, token, 'PUT', `/listeners/${upload.manifest.listener_id}/chunks/${upload.manifest.chunk_id}`, upload.body, {
    'content-type': 'audio/wav',
    'x-sanctum-manifest': JSON.stringify(upload.manifest),
  });

/** Registers a listener and claims its lease; returns its ID and ownership generation. */
export const claimListener = (host: string, token: string, name = 'Room') =>
  Effect.gen(function* () {
    const registered = yield* api(host, token, 'POST', '/listeners', { name, mode: 'room', capabilities: {} });
    const listener_id = registered.body.id as ListenerId;
    const beat = yield* api(host, token, 'POST', `/listeners/${listener_id}/heartbeat`, {
      lease_generation: 0,
      state: 'starting',
      epoch_id: null,
      buffered_chunks: 0,
      storage_bytes_free: null,
    });
    return { listener_id, lease_generation: beat.body.lease_generation as number };
  });

/** HTTP status of a WebSocket upgrade attempt that the server refuses (101 when it would upgrade). */
export const upgradeStatus = (host: string, path: string, headers: Record<string, string>) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const [hostname, port] = host.split(':');
        const req = request({
          hostname,
          port: Number(port),
          path,
          headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
        });
        req.on('upgrade', (_response, socket) => {
          socket.destroy();
          resolve(101);
        });
        req.on('response', response => resolve(response.statusCode ?? 0));
        req.on('error', reject);
        req.end();
      }),
  );

interface TestSocket {
  readonly messages: Array<ServerControlMessage>;
  /** Removes and returns the first received message with `tag`, waiting up to 5 s. */
  readonly take: <T extends ServerControlMessage['_tag']>(tag: T) => Effect.Effect<Extract<ServerControlMessage, { _tag: T }>>;
  readonly send: (data: string | Uint8Array) => void;
  readonly closed: Effect.Effect<{ readonly code: number; readonly reason: string }>;
  readonly close: () => void;
}

/** Opens a live-ingest socket as a browser would (Origin plus credentials); the test scope closes it. */
export const openSocket = (host: string, listener_id: string, token: string) =>
  Effect.acquireRelease(Effect.promise(
    () =>
      new Promise<TestSocket>((resolve, reject) => {
        const init = { headers: { authorization: `Bearer ${token}`, origin: `http://${host}` } };
        const socket = new WebSocket(`ws://${host}/api/v1/listeners/${listener_id}/stream`, init as unknown as string[]);
        socket.binaryType = 'arraybuffer';
        const messages: Array<ServerControlMessage> = [];
        const closed = new Promise<{ code: number; reason: string }>(done => socket.addEventListener('close', event => done({ code: event.code, reason: event.reason })));
        socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));
        socket.addEventListener('error', () => reject(new Error('socket error')));
        const take = <T extends ServerControlMessage['_tag']>(tag: T) =>
          Effect.promise(async () => {
            for (const deadline = Date.now() + 5_000; Date.now() < deadline; await new Promise(wait => setTimeout(wait, 10))) {
              const index = messages.findIndex(message => message._tag === tag);
              if (index >= 0) return messages.splice(index, 1)[0] as Extract<ServerControlMessage, { _tag: T }>;
            }
            throw new Error(`no ${tag} message; received ${JSON.stringify(messages)}`);
          });
        socket.addEventListener('open', () =>
          resolve({ messages, take, send: data => socket.send(data), closed: Effect.promise(() => closed), close: () => socket.close() }),
        );
      }),
  ), socket => Effect.sync(socket.close));

export const startMessage = (input: { readonly listener_id: string; readonly epoch_id: string; readonly lease_generation: number; readonly sample_start?: number; readonly archive_only?: boolean }) =>
  JSON.stringify({
    _tag: 'start',
    protocol_version: 1,
    listener_id: input.listener_id,
    epoch_id: input.epoch_id,
    track: 0,
    clock: { sample_rate: 16_000, channels: 1, encoding: 'pcm_s16le', sample_start: input.sample_start ?? 0, captured_at: '2026-09-26T17:00:00Z', timezone: 'America/Los_Angeles' },
    lease_generation: input.lease_generation,
    ...(input.archive_only === undefined ? {} : { archive_only: input.archive_only }),
  });

/** One binary PCM frame of `count` samples (a quiet ramp) at `sample_start`. */
export const pcmFrame = (sequence: number, sample_start: number, count = 1_600) =>
  encodePcmFrame({ track: 0, sequence, sample_start, sample_count: count }, Int16Array.from({ length: count }, (_, i) => (i % 200) - 100));

/** Real-time wait, independent of the test clock. */
export const pause = (ms: number) => Effect.sleep(ms).pipe(Effect.withClock(liveClock));

/** Re-runs `read` every 50 ms until `done` holds (at most 5 s); returns the last value. */
export const eventually = <A, E, R>(read: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  read.pipe(
    Effect.filterOrFail(done, value => new Error(`condition not reached: ${JSON.stringify(value)}`)),
    Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo('5 seconds'))),
    Effect.orDie,
    Effect.withClock(liveClock),
  );
