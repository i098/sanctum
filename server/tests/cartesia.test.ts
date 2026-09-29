/** Cartesia adapter against a local stand-in server; no request leaves the machine. */
import { createServer, type IncomingMessage } from 'node:http';
import { describe, expect, it } from '@effect/vitest';
import { Chunk, Effect, Fiber, Option, Redacted, Stream } from 'effect';
import { CARTESIA_API_VERSION, cartesiaSynthesizer } from '../src/providers/cartesia.ts';

interface Seen { headers: IncomingMessage['headers']; body: Record<string, unknown>; aborted: boolean }

/** Answers `/tts/bytes` with `reply`; records each request and whether the client hung up early. */
const fakeCartesia = (reply: (response: import('node:http').ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const seen: Seen[] = [];
      const server = createServer((request, response) => {
        let text = '';
        request.on('data', part => (text += part));
        request.on('end', () => {
          const entry: Seen = { headers: request.headers, body: JSON.parse(text), aborted: false };
          seen.push(entry);
          response.on('close', () => (entry.aborted = !response.writableFinished));
          reply(response);
        });
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      return { server, seen, baseUrl: `http://127.0.0.1:${port}` };
    }),
    ({ server }) => Effect.promise(() => new Promise(resolve => server.close(resolve)).then(() => server.closeAllConnections())),
  );

const configured = (baseUrl: string) => cartesiaSynthesizer({ apiKey: Option.some(Redacted.make('sk_car_fixture')), voiceId: Option.some('voice-1'), baseUrl });

describe('Cartesia speech output', () => {
  it.scoped('streams raw PCM16 for one sentence with the documented request shape', () =>
    Effect.gen(function* () {
      const fake = yield* fakeCartesia(response => {
        response.writeHead(200, { 'content-type': 'audio/pcm' });
        response.write(Buffer.alloc(960, 1));
        response.end(Buffer.alloc(480, 2));
      });
      const audio = Chunk.toArray(yield* Stream.runCollect(configured(fake.baseUrl).synthesize('Hello there.')));
      expect(audio.reduce((total, part) => total + part.byteLength, 0)).toBe(1_440);
      expect(fake.seen[0]!.headers).toMatchObject({ authorization: 'Bearer sk_car_fixture', 'cartesia-version': CARTESIA_API_VERSION });
      expect(fake.seen[0]!.body).toEqual({
        model_id: 'sonic-3',
        transcript: 'Hello there.',
        voice: { id: 'voice-1' },
        language: 'en',
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24_000 },
      });
    }));

  it.scoped('aborts generation when playback is cancelled', () =>
    Effect.gen(function* () {
      const fake = yield* fakeCartesia(response => {
        response.writeHead(200);
        response.write(Buffer.alloc(960));
      });
      const received: number[] = [];
      const fiber = yield* Effect.fork(Stream.runForEach(configured(fake.baseUrl).synthesize('A long answer.'), part => Effect.sync(() => received.push(part.byteLength))));
      const until = (done: () => boolean) =>
        Effect.promise(async () => {
          while (!done()) await new Promise(resolve => setTimeout(resolve, 20));
        }).pipe(Effect.timeout('5 seconds'));
      yield* until(() => received.length > 0);
      yield* Fiber.interrupt(fiber);
      yield* until(() => fake.seen[0]!.aborted);
      expect(received).toEqual([960]);
    }));

  it.scoped('reports provider errors and missing configuration as unavailable, never as speech', () =>
    Effect.gen(function* () {
      const fake = yield* fakeCartesia(response => {
        response.writeHead(429, { 'retry-after': '3' });
        response.end('{"error":"rate limited"}');
      });
      const limited = yield* Effect.flip(Stream.runDrain(configured(fake.baseUrl).synthesize('Hi.')));
      expect(limited).toMatchObject({ _tag: 'Unavailable', retryable: true, retry_after_ms: 3_000 });
      const unconfigured = cartesiaSynthesizer({ apiKey: Option.none(), voiceId: Option.some('voice-1'), baseUrl: fake.baseUrl });
      expect(yield* Effect.flip(Stream.runDrain(unconfigured.synthesize('Hi.')))).toMatchObject({ _tag: 'Unavailable', retryable: false });
      expect(fake.seen).toHaveLength(1);
    }));
});
