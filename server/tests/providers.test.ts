import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from '@effect/vitest';
import { ConfigProvider, Effect, Layer, Option, Queue, Redacted, Stream } from 'effect';
import { engineeringDefaults } from '../src/config.ts';
import { SpeechToTextLive } from '../src/media/providers.ts';
import { ObjectStore } from '../src/providers/object-store.ts';
import { SpeechToText, whisperSpeechToText } from '../src/providers/whisper.ts';
import { R2ObjectStoreLive } from '../src/providers/r2.ts';

/** Local HTTP stand-in for a provider; records requests and answers with `respond`. */
const localServer = (respond: (request: IncomingMessage, body: Buffer, response: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ url: string; requests: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }> }>(resolve => {
          const requests: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }> = [];
          const server = createServer((request, response) => {
            const parts: Array<Buffer> = [];
            request.on('data', part => parts.push(part));
            request.on('end', () => {
              const body = Buffer.concat(parts);
              requests.push({ method: request.method!, url: request.url!, headers: request.headers, body });
              respond(request, body, response);
            });
          });
          server.listen(0, '127.0.0.1', () => {
            const address = server.address() as { port: number };
            resolve(Object.assign({ url: `http://127.0.0.1:${address.port}`, requests }, { close: () => server.close() }));
          });
        }),
    ),
    server => Effect.sync(() => (server as unknown as { close: () => void }).close()),
  );

const withConfig = (values: Record<string, string>) => Layer.setConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(values))));

describe('R2 object store', () => {
  it.scoped('writes, heads and reads private objects through the S3 API with server-side credentials', () =>
    Effect.gen(function* () {
      const objects = new Map<string, { body: Buffer; sha: string }>();
      const server = yield* localServer((request, body, response) => {
        const key = request.url!.split('?')[0]!;
        if (request.method === 'PUT') {
          if (key.endsWith('broken.wav')) return response.writeHead(500).end();
          objects.set(key, { body, sha: String(request.headers['x-amz-meta-sha256']) });
          return response.writeHead(200).end();
        }
        const object = objects.get(key);
        if (object === undefined) return response.writeHead(404).end();
        response.writeHead(200, { 'content-length': object.body.length, 'x-amz-meta-sha256': object.sha });
        response.end(request.method === 'HEAD' ? undefined : object.body);
      });
      const config = withConfig({ R2_ENDPOINT: server.url, R2_BUCKET: 'audio', R2_ACCESS_KEY_ID: 'key-id', R2_SECRET_ACCESS_KEY: 'secret', R2_PREFIX: 'private/' });
      const store = yield* Effect.provide(ObjectStore, R2ObjectStoreLive.pipe(Layer.provide(config)));
      const sha = 'ab'.repeat(32);
      expect(yield* store.put('w/1.wav', new Uint8Array([1, 2, 3]), { sha256: sha, contentType: 'audio/wav' })).toEqual({ key: 'w/1.wav', byte_length: 3, sha256: sha });
      const put = server.requests[0]!;
      expect(put.url).toBe('/audio/private/w/1.wav');
      expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=key-id\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=\S*x-amz-meta-sha256\S*, Signature=[0-9a-f]{64}$/);
      expect(put.headers['x-amz-content-sha256']).toBe(createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'));
      expect(yield* store.head('w/1.wav')).toEqual({ key: 'w/1.wav', byte_length: 3, sha256: sha });
      expect(yield* store.head('missing.wav')).toBeNull();
      expect([...(yield* store.get('w/1.wav'))]).toEqual([1, 2, 3]);
      expect((yield* Effect.flip(store.get('missing.wav'))).message).toBe('not found');
      expect(yield* Effect.flip(store.put('broken.wav', new Uint8Array([1]), { sha256: sha, contentType: 'audio/wav' }))).toMatchObject({ ambiguous: true });
      const signed = new URL(yield* store.presignGet('w/1.wav', 300_000));
      expect(signed.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(signed.pathname).toBe('/audio/private/w/1.wav');
      expect(signed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    }),
  );

  it.effect('fails every call visibly when R2 is not configured', () =>
    Effect.gen(function* () {
      const store = yield* Effect.provide(ObjectStore, R2ObjectStoreLive.pipe(Layer.provide(withConfig({}))));
      const failure = yield* Effect.flip(store.put('k', new Uint8Array([1]), { sha256: 'ab'.repeat(32), contentType: 'audio/wav' }));
      expect(failure).toMatchObject({ ambiguous: false, message: expect.stringContaining('R2 is not configured') });
    }),
  );
});

/** The WAV a Whisper request carried: its sample rate and samples. */
const sentAudio = (body: Buffer) => {
  const wav = Buffer.from(JSON.parse(body.toString()).audio, 'base64');
  return { rate: wav.readUInt32LE(24), samples: new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.byteLength)) };
};

const whisper = (baseUrl: string) =>
  whisperSpeechToText({ workersAi: Option.some({ baseUrl: `${baseUrl}/accounts/acct/ai`, apiToken: Redacted.make('wai-token') }), liveAsr: engineeringDefaults.liveAsr });

/** 20 ms of speech-level audio at 16 kHz. */
const speech = Int16Array.from({ length: 320 }, (_, i) => (i % 2 === 0 ? 2_000 : -2_000));

describe('Workers AI Whisper', () => {
  it.scoped('transcribes a batch range, keeping segment times relative to its first sample', () =>
    Effect.gen(function* () {
      let status = 200;
      const server = yield* localServer((_request, _body, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: true, result: { text: 'batch words', segments: [{ start: 0.25, end: 1, text: ' batch words ' }, { start: 1, end: 1.5, text: ' ' }] } }));
      });
      const stt = whisper(server.url);
      expect(yield* stt.transcribe(16_000, speech)).toEqual([{ start_s: 0.25, end_s: 1, is_final: true, text: 'batch words', confidence: null, speaker: null }]);
      const request = server.requests[0]!;
      expect(request.url).toBe('/accounts/acct/ai/run/@cf/openai/whisper-large-v3-turbo');
      expect(request.headers.authorization).toBe('Bearer wai-token');
      expect(JSON.parse(request.body.toString())).toMatchObject({ vad_filter: true });
      expect(sentAudio(request.body)).toEqual({ rate: 16_000, samples: speech });
      status = 503;
      expect(yield* Effect.flip(stt.transcribe(16_000, speech))).toMatchObject({ _tag: 'Unavailable', retryable: true });
      status = 401;
      expect(yield* Effect.flip(stt.transcribe(16_000, speech))).toMatchObject({ retryable: false });
    }),
  );

  it.scoped('treats a silent chunk without segments as no results, and text without segments as a failure', () =>
    Effect.gen(function* () {
      let result: object = { text: '' };
      const server = yield* localServer((_request, _body, response) => response.end(JSON.stringify({ success: true, result })));
      const stt = whisper(server.url);
      expect(yield* stt.transcribe(16_000, speech)).toEqual([]);
      result = { text: ' ', vtt: '', word_count: 0 };
      expect(yield* stt.transcribe(16_000, speech)).toEqual([]);
      result = { text: 'spoken' };
      expect(yield* Effect.flip(stt.transcribe(16_000, speech))).toMatchObject({ _tag: 'Unavailable', retryable: false });
    }),
  );

  it.scoped('sends no request for audio below the speech floor and sends quiet speech above it', () =>
    Effect.gen(function* () {
      const server = yield* localServer((_request, _body, response) => response.end(JSON.stringify({ result: { text: 'quiet words', segments: [{ start: 0, end: 1, text: 'quiet words' }] } })));
      const stt = whisper(server.url);
      const room = Int16Array.from({ length: 16_000 }, (_, i) => (i % 2 === 0 ? 40 : -40));
      expect(yield* stt.transcribe(16_000, room)).toEqual([]);
      const stream = yield* stt.openStream(16_000, () => Effect.void);
      const collected = yield* Effect.fork(Stream.runCollect(stream.results));
      for (let at = 0; at < 48_000; at += 1_600) stream.send(room.subarray(0, 1_600));
      yield* stream.finish;
      expect([...(yield* Effect.flatten(collected.await))]).toEqual([]);
      expect(server.requests).toHaveLength(0);
      const quiet = new Int16Array(16_000);
      quiet.fill(60, 8_000, 8_320);
      expect(yield* stt.transcribe(16_000, quiet)).toMatchObject([{ text: 'quiet words' }]);
      expect(server.requests).toHaveLength(1);
    }),
  );

  it.scopedLive('backs off on 429 and skips the chunks, reporting them behind, without ending the stream', () =>
    Effect.gen(function* () {
      const server = yield* localServer((_request, _body, response) => response.writeHead(429, { 'retry-after': '60' }).end());
      const stt = whisper(server.url);
      const behind = yield* Queue.unbounded<number>();
      const stream = yield* stt.openStream(16_000, offset => Queue.offer(behind, offset));
      const collected = yield* Effect.fork(Stream.runCollect(stream.results));
      const feed = () => {
        for (let at = 0; at < 25; at++) stream.send(new Int16Array(1_600).fill(8_000));
      };
      feed();
      expect(yield* Queue.take(behind)).toBe(0);
      feed();
      yield* stream.finish;
      expect([...(yield* Effect.flatten(collected.await))]).toEqual([]);
      expect([...(yield* Queue.takeAll(behind))]).toEqual([24_160, 48_320]);
      expect(server.requests).toHaveLength(1);
    }),
  );

  it.scopedLive('sends live audio in chunks cut at a quiet moment and emits one final per chunk in audio order', () =>
    Effect.gen(function* () {
      // The first chunk is answered only after the second; results must still follow the audio.
      const cut = 25_600 + 160;
      let held: (() => void) | null = null;
      let answeredLater = false;
      const server = yield* localServer((_request, body, response) => {
        const { samples } = sentAudio(body);
        const reply = () => response.end(JSON.stringify({ result: { text: `heard ${samples.length}`, segments: [{ start: 0.1, end: 0.5, text: `heard ${samples.length}` }] } }));
        if (samples.length !== cut) {
          reply();
          answeredLater = true;
          held?.();
        } else if (answeredLater) reply();
        else held = reply;
      });
      const stt = whisper(server.url);
      const stream = yield* stt.openStream(16_000, () => Effect.void);
      const collected = yield* Effect.fork(Stream.runCollect(stream.results));
      // 2.5 s of loud audio with a pause at 1.6-1.7 s, then 0.5 s more.
      const audio = new Int16Array(48_000).fill(8_000).fill(0, 25_600, 27_200);
      for (let at = 0; at < audio.length; at += 1_600) expect(stream.send(audio.subarray(at, at + 1_600))).toBe(true);
      yield* stream.finish;
      expect(stream.send(new Int16Array(1))).toBe(false);
      const results = [...(yield* Effect.flatten(collected.await))];
      expect(server.requests.map(request => sentAudio(request.body).samples.length).sort()).toEqual([48_000 - cut, cut].sort());
      expect(results).toEqual([
        { start_s: 0.1, end_s: 0.5, is_final: true, text: `heard ${cut}`, confidence: null, speaker: null },
        { start_s: cut / 16_000 + 0.1, end_s: cut / 16_000 + 0.5, is_final: true, text: `heard ${48_000 - cut}`, confidence: null, speaker: null },
      ]);
      expect(stream.backlogBytes()).toBe(0);
    }),
  );

  it.effect('reports missing settings as unavailable instead of pretending to transcribe', () =>
    Effect.gen(function* () {
      const stt = yield* Effect.provide(SpeechToText, SpeechToTextLive.pipe(Layer.provide(withConfig({ WORKERS_AI_ACCOUNT_ID: 'acct' }))));
      expect(yield* Effect.flip(stt.transcribe(16_000, new Int16Array(1)))).toMatchObject({ _tag: 'Unavailable', retryable: false });
      expect(yield* Effect.flip(Effect.scoped(stt.openStream(16_000, () => Effect.void)))).toMatchObject({
        message: 'Workers AI: WORKERS_AI_ACCOUNT_ID and WORKERS_AI_API_TOKEN are not configured',
      });
    }),
  );
});
