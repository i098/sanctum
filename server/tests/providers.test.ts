import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse, Socket } from '@effect/platform';
import { NodeHttpServer } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { ConfigProvider, Context, Effect, Layer, Stream } from 'effect';
import { ObjectStore } from '../src/object-store.ts';
import { DeepgramLive, parseLiveMessage, SpeechToText } from '../src/providers/deepgram.ts';
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

/** Local stand-in for Deepgram's `/v1/listen` socket: interim result per audio message, final on CloseStream. */
const fakeDeepgramSocket = Effect.gen(function* () {
  const seen = { protocols: '', query: '', bytes: 0 };
  const route = HttpRouter.empty.pipe(
    HttpRouter.get(
      '/v1/listen',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        seen.protocols = request.headers['sec-websocket-protocol'] ?? '';
        seen.query = request.url;
        const socket = yield* request.upgrade;
        const write = yield* socket.writer;
        const results = (is_final: boolean, text: string) =>
          JSON.stringify({ type: 'Results', start: 0, duration: seen.bytes / 32_000, is_final, channel: { alternatives: [{ transcript: text, confidence: 0.9, words: [{ speaker: 1 }] }] } });
        yield* socket.runRaw(data =>
          typeof data === 'string'
            ? data.includes('CloseStream')
              ? Effect.zipRight(write(results(true, 'final words')), write(new Socket.CloseEvent(1000)))
              : Effect.void
            : Effect.suspend(() => {
                seen.bytes += data.byteLength;
                return Effect.zipRight(write(JSON.stringify({ type: 'Metadata' })), write(results(false, 'interim')));
              }),
        );
        return HttpServerResponse.empty();
      }),
    ),
  );
  const context = yield* Layer.build(HttpServer.serve(route).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: '127.0.0.1' }))));
  const address = Context.get(context, HttpServer.HttpServer).address as HttpServer.TcpAddress;
  return { url: `http://127.0.0.1:${address.port}`, seen };
});

describe('Deepgram adapters', () => {
  it('parses Results messages and ignores other message types', () => {
    const message = { type: 'Results', start: 1.5, duration: 0.5, is_final: true, channel: { alternatives: [{ transcript: 'hi', confidence: 0.8, words: [{ speaker: 2 }] }] } };
    expect(parseLiveMessage(JSON.stringify(message))).toEqual({ start_s: 1.5, end_s: 2, is_final: true, text: 'hi', confidence: 0.8, speaker: '2' });
    expect(parseLiveMessage(JSON.stringify({ type: 'Metadata', request_id: 'x' }))).toBeNull();
    expect(parseLiveMessage('not json')).toBeNull();
  });

  it.scopedLive('streams PCM over an authenticated socket and flushes finals on finish', () =>
    Effect.gen(function* () {
      const fake = yield* fakeDeepgramSocket;
      const stt = yield* Effect.provide(SpeechToText, DeepgramLive.pipe(Layer.provide(withConfig({ DEEPGRAM_API_KEY: 'dg-key', DEEPGRAM_URL: fake.url }))));
      const stream = yield* stt.openStream(16_000);
      expect(stream.send(new Int16Array(800))).toBe(true);
      const collected = Stream.runCollect(stream.results).pipe(Effect.fork);
      const fiber = yield* collected;
      yield* Effect.sleep('100 millis');
      yield* stream.finish;
      const results = [...(yield* fiber.await.pipe(Effect.flatten))];
      expect(fake.seen.protocols).toBe('token, dg-key');
      expect(fake.seen.query).toContain('encoding=linear16');
      expect(fake.seen.query).toContain('sample_rate=16000');
      expect(fake.seen.bytes).toBe(1_600);
      expect(results).toEqual([
        { start_s: 0, end_s: 0.05, is_final: false, text: 'interim', confidence: 0.9, speaker: '1' },
        { start_s: 0, end_s: 0.05, is_final: true, text: 'final words', confidence: 0.9, speaker: '1' },
      ]);
    }),
  );

  it.scoped('transcribes a batch range and maps utterances, failing visibly on provider errors', () =>
    Effect.gen(function* () {
      let status = 200;
      const server = yield* localServer((_request, _body, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ results: { utterances: [{ start: 0.25, end: 1, transcript: 'batch words', confidence: 0.7, speaker: 0 }] } }));
      });
      const stt = yield* Effect.provide(SpeechToText, DeepgramLive.pipe(Layer.provide(withConfig({ DEEPGRAM_API_KEY: 'dg-key', DEEPGRAM_URL: server.url }))));
      expect(yield* stt.transcribe(16_000, new Int16Array([1, -1]))).toEqual([{ start_s: 0.25, end_s: 1, is_final: true, text: 'batch words', confidence: 0.7, speaker: '0' }]);
      expect(server.requests[0]!.headers.authorization).toBe('Token dg-key');
      expect(server.requests[0]!.url).toContain('utterances=true');
      expect([...server.requests[0]!.body]).toEqual([1, 0, 255, 255]);
      status = 503;
      expect(yield* Effect.flip(stt.transcribe(16_000, new Int16Array(1)))).toMatchObject({ _tag: 'Unavailable', retryable: true });
      status = 401;
      expect(yield* Effect.flip(stt.transcribe(16_000, new Int16Array(1)))).toMatchObject({ retryable: false });
    }),
  );

  it.effect('reports a missing API key as unavailable instead of pretending to transcribe', () =>
    Effect.gen(function* () {
      const stt = yield* Effect.provide(SpeechToText, DeepgramLive.pipe(Layer.provide(withConfig({}))));
      expect(yield* Effect.flip(stt.transcribe(16_000, new Int16Array(1)))).toMatchObject({ _tag: 'Unavailable', retryable: false });
      expect(yield* Effect.flip(Effect.scoped(stt.openStream(16_000)))).toMatchObject({ message: 'Deepgram: DEEPGRAM_API_KEY is not configured' });
    }),
  );
});
