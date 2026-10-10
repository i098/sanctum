/** Workers AI speech adapter against a local stand-in; no request leaves the machine. */
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from '@effect/vitest';
import { Chunk, Effect, Fiber, Option, Redacted, Stream } from 'effect';
import { vi } from 'vitest';
import { SPEECH_MODEL, auraSynthesizer } from '../src/providers/speech.ts';

interface Seen { aborted: boolean }

/** Answers the Workers AI run endpoint and records whether the client hung up early. */
const fakeWorkersAi = (reply: (response: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const seen: Seen[] = [];
      const server = createServer((request, response) => {
        if (request.url !== `/run/${SPEECH_MODEL}`) {
          response.writeHead(404).end();
          return;
        }
        request.resume();
        request.on('end', () => {
          const entry: Seen = { aborted: false };
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

const configured = (baseUrl: string) => auraSynthesizer(Option.some({ apiToken: Redacted.make('workers-ai-fixture'), baseUrl }));

describe('Workers AI speech output', () => {
  it.scoped('streams raw PCM16 chunks in order for one sentence', () =>
    Effect.gen(function* () {
      const fake = yield* fakeWorkersAi(response => {
        // The real provider also sends audio/mpeg for raw linear16.
        response.writeHead(200, { 'content-type': 'audio/mpeg' });
        response.write(Buffer.alloc(960, 1));
        response.end(Buffer.alloc(480, 2));
      });
      const audio = Chunk.toArray(yield* Stream.runCollect(configured(fake.baseUrl).synthesize('Hello there.')));
      expect(Buffer.concat(audio)).toEqual(Buffer.concat([Buffer.alloc(960, 1), Buffer.alloc(480, 2)]));
      expect(audio.every(part => part.byteLength % 2 === 0)).toBe(true);
    }));

  for (const headersSent of [false, true]) {
    it.scoped(`aborts the in-flight request ${headersSent ? 'during audio' : 'before headers'}`, () =>
      Effect.gen(function* () {
        const fake = yield* fakeWorkersAi(response => {
          if (headersSent) {
            response.writeHead(200);
            response.write(Buffer.alloc(960));
          }
        });
        const received: number[] = [];
        const fiber = yield* Effect.fork(Stream.runForEach(configured(fake.baseUrl).synthesize('A long answer.'), part => Effect.sync(() => received.push(part.byteLength))));
        const until = (done: () => boolean) =>
          Effect.promise(async () => {
            while (!done()) await new Promise(resolve => setTimeout(resolve, 20));
          }).pipe(Effect.timeout('5 seconds'));
        yield* until(() => fake.seen.length > 0 && (!headersSent || received.length > 0));
        yield* Fiber.interrupt(fiber);
        yield* until(() => fake.seen[0]!.aborted);
        expect(received).toEqual(headersSent ? [960] : []);
      }));
  }

  it.scoped('preserves samples split across HTTP chunks and rejects a truncated sample', () =>
    Effect.gen(function* () {
      const fetchMock = yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(globalThis, 'fetch')),
        mock => Effect.sync(() => mock.mockRestore()),
      );
      fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) {
          for (const part of [[0], [1, 2, 3], [4, 5, 6], [7]]) controller.enqueue(Uint8Array.from(part));
          controller.close();
        },
      })));
      const audio = Chunk.toArray(yield* Stream.runCollect(configured('http://fixture').synthesize('Hi.')));
      expect(audio.every(part => part.byteLength % 2 === 0)).toBe(true);
      expect(Buffer.concat(audio)).toEqual(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
      fetchMock.mockResolvedValueOnce(new Response(Uint8Array.of(1)));
      expect(yield* Effect.flip(Stream.runDrain(configured('http://fixture').synthesize('Hi.')))).toMatchObject({
        _tag: 'Unavailable', message: 'Workers AI speech ended with an incomplete PCM16 sample',
      });
    }));

  it.scoped('reports provider errors and missing configuration as unavailable, never as speech', () =>
    Effect.gen(function* () {
      const fake = yield* fakeWorkersAi(response => {
        response.writeHead(429, { 'retry-after': '3' });
        response.end('{"error":"rate limited"}');
      });
      const limited = yield* Effect.flip(Stream.runDrain(configured(fake.baseUrl).synthesize('Hi.')));
      expect(limited).toMatchObject({ _tag: 'Unavailable', retryable: true, retry_after_ms: 3_000 });
      const unconfigured = auraSynthesizer(Option.none());
      expect(yield* Effect.flip(Stream.runDrain(unconfigured.synthesize('Hi.')))).toMatchObject({ _tag: 'Unavailable', retryable: false });
      expect(fake.seen).toHaveLength(1);
    }));
});
