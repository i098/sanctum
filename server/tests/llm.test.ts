/**
 * Provider clients against a local HTTP server replaying recorded-shape Cerebras and Anthropic
 * responses; no live provider or real credential is used. Tests run on the live clock because
 * provider timeouts and retry backoff are real timers.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from '@effect/vitest';
import { ConfigProvider, Effect, Exit, Fiber, Layer, Schema, Stream } from 'effect';
import { engineeringDefaults } from '../src/config.ts';
import { LlmClient, LlmLive, makeLlm } from '../src/llm.ts';
import { anthropic } from '../src/providers/anthropic.ts';
import { cerebras } from '../src/providers/cerebras.ts';

interface Seen {
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: Record<string, any>;
}

type Reply = (response: ServerResponse) => void;

/** Local server answering each request with the next reply; counts requests the client abandoned. */
const replayServer = (replies: ReadonlyArray<Reply>) =>
  Effect.acquireRelease(
    Effect.async<{ url: string; seen: Seen[]; aborted: () => number; close: () => void }>(resume => {
      const seen: Seen[] = [];
      let aborted = 0;
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
          seen.push({ path: request.url ?? '', headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
          response.on('close', () => {
            if (!response.writableEnded) aborted++;
          });
          (replies[seen.length - 1] ?? (res => res.writeHead(500).end('no reply')))(response);
        });
      });
      server.listen(0, '127.0.0.1', () =>
        resume(Effect.succeed({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, aborted: () => aborted, close: () => {
          server.closeAllConnections();
          server.close();
        } })),
      );
    }),
    server => Effect.sync(server.close),
  );

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => response =>
  response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
const sse = (events: ReadonlyArray<string>): Reply => response => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  events.forEach(event => response.write(`${event}\n\n`));
  response.end();
};
const hang: Reply = () => {};

const completion = (content: string, finish_reason = 'stop') => json(200, { id: 'chatcmpl-1', object: 'chat.completion', model: 'qwen-3.8-27b', choices: [{ index: 0, finish_reason, message: { role: 'assistant', content } }] });
const message = (content: unknown[], stop_reason = 'end_turn') =>
  json(200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });

const Answer = Schema.Struct({ kind: Schema.Literal('decision', 'commitment'), text: Schema.String, quote: Schema.NullOr(Schema.String) });
const ask = { system: 'Extract.', prompt: 'Transcript', name: 'answer', output: Answer };
const budget = { ...engineeringDefaults.modelRequest, timeoutMs: 400 };
const roles = engineeringDefaults.modelRoles;
const withCerebras = (url: string) => makeLlm(roles, { cerebras: cerebras({ apiKey: 'test-key', baseUrl: url }) }, budget);
const withAnthropic = (url: string) => makeLlm(roles, { anthropic: anthropic({ apiKey: 'test-key', baseUrl: url }) }, budget);

describe('Cerebras client', () => {
  it.scopedLive('sends the role model, reasoning effort and a strict schema, then decodes the JSON answer', () =>
    Effect.gen(function* () {
      const server = yield* replayServer([completion('{"kind":"decision","text":"Ship Friday","quote":"we ship Friday"}')]);
      const result = yield* withCerebras(server.url).generate('extraction', ask);
      expect(result).toEqual({ model: 'qwen-3.8-27b', value: { kind: 'decision', text: 'Ship Friday', quote: 'we ship Friday' } });
      const [request] = server.seen;
      expect(request!.path).toBe('/v1/chat/completions');
      expect(request!.headers.authorization).toBe('Bearer test-key');
      expect(request!.headers['x-cerebras-version-patch']).toBe('2');
      expect(request!.body).toMatchObject({ model: 'qwen-3.8-27b', reasoning_effort: 'low', stream: false, max_completion_tokens: 4_096 });
      expect(request!.body.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          strict: true,
          schema: {
            type: 'object',
            required: ['kind', 'text', 'quote'],
            properties: { kind: { type: 'string', enum: ['decision', 'commitment'] }, text: { type: 'string' }, quote: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
            additionalProperties: false,
          },
        },
      });
    }));

  it.scopedLive('retries rate limits and server errors a bounded number of times', () =>
    Effect.gen(function* () {
      const recovered = yield* replayServer([json(429, { error: 'slow down' }, { 'retry-after': '0' }), completion('{"kind":"commitment","text":"Send notes","quote":null}')]);
      expect((yield* withCerebras(recovered.url).generate('extraction', ask)).value.kind).toBe('commitment');
      expect(recovered.seen).toHaveLength(2);

      const down = yield* replayServer([json(503, {}), json(500, {}), json(502, {}, { 'retry-after': '7' }), completion('{}')]);
      const failure = yield* Effect.flip(withCerebras(down.url).generate('extraction', ask));
      expect(failure).toMatchObject({ _tag: 'Unavailable', retryable: true, retry_after_ms: 7_000 });
      expect(down.seen).toHaveLength(budget.maxAttempts);
    }));

  it.scopedLive('does not retry client errors, truncation or output that fails the schema', () =>
    Effect.gen(function* () {
      const server = yield* replayServer([
        json(400, { message: 'bad schema' }),
        completion('{"kind":"decision","text":"cut', 'length'),
        completion('{"kind":"rumour","text":"x","quote":null}'),
        completion('not json'),
      ]);
      const llm = withCerebras(server.url);
      const messages = [];
      for (let i = 0; i < 4; i++) {
        const failure = yield* Effect.flip(llm.generate('extraction', ask));
        expect(failure.retryable).toBe(false);
        messages.push(failure.message);
      }
      expect(messages[0]).toMatch(/HTTP 400/);
      expect(messages[1]).toMatch(/truncated/);
      expect(messages[2]).toMatch(/failed the answer schema/);
      expect(messages[3]).toMatch(/failed the answer schema/);
      expect(server.seen).toHaveLength(4);
    }));

  it.scopedLive('times out each attempt, aborting the HTTP request, and cancels on interruption', () =>
    Effect.gen(function* () {
      const server = yield* replayServer([hang, hang, hang, hang]);
      const llm = makeLlm(roles, { cerebras: cerebras({ apiKey: 'test-key', baseUrl: server.url }) }, { ...budget, maxAttempts: 1 });
      const timedOut = yield* Effect.flip(llm.generate('extraction', ask));
      expect(timedOut).toMatchObject({ _tag: 'Unavailable', retryable: true, message: 'extraction model timed out after 400 ms' });
      const fiber = yield* Effect.fork(llm.generate('extraction', ask));
      yield* Effect.sleep('100 millis');
      yield* Fiber.interrupt(fiber);
      yield* Effect.sleep('100 millis');
      expect(server.seen).toHaveLength(2);
      expect(server.aborted()).toBe(2);
    }));

  it.scopedLive('streams SSE text deltas and aborts the request when the consumer stops early', () =>
    Effect.gen(function* () {
      const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}`;
      const server = yield* replayServer([sse([chunk('It is '), chunk('on Friday.'), 'data: [DONE]']), response => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`${chunk('First')}\n\n`);
      }, sse([chunk('cut off')])]);
      const llm = withCerebras(server.url);
      const request = { system: 'Answer briefly.', prompt: 'When?' };
      expect((yield* Stream.runCollect(llm.stream('voice', request))).pipe(chunks => [...chunks].join(''))).toBe('It is on Friday.');
      expect(server.seen[0]!.body).toMatchObject({ model: 'qwen-3.8-27b', stream: true, reasoning_effort: 'none' });
      expect([...(yield* Stream.runCollect(Stream.take(llm.stream('voice', request), 1)))]).toEqual(['First']);
      yield* Effect.sleep('100 millis');
      expect(server.aborted()).toBe(1);
      const truncated = yield* Effect.flip(Stream.runDrain(llm.stream('voice', request)));
      expect(truncated.message).toMatch(/ended before \[DONE\]/);
    }));

  it.effect('fails visibly without a key and never falls back to another provider', () =>
    Effect.gen(function* () {
      const llm = makeLlm(roles, { anthropic: anthropic({ apiKey: 'unused', baseUrl: 'http://127.0.0.1:9' }) });
      const failure = yield* Effect.flip(llm.generate('extraction', ask));
      expect(failure).toMatchObject({ retryable: false, message: 'extraction model provider cerebras is not configured (CEREBRAS_API_KEY)' });
      expect((yield* Effect.flip(Stream.runDrain(llm.stream('voice', { system: '', prompt: '' })))).message).toMatch(/CEREBRAS_API_KEY/);
    }));
});

describe('Anthropic client', () => {
  it.scopedLive('requests structured output with output_config and decodes it', () =>
    Effect.gen(function* () {
      const server = yield* replayServer([message([{ type: 'text', text: '{"kind":"decision","text":"Use MySQL","quote":null}' }])]);
      const result = yield* withAnthropic(server.url).generate('planner', ask);
      expect(result).toEqual({ model: 'claude-sonnet-5-5', value: { kind: 'decision', text: 'Use MySQL', quote: null } });
      const [request] = server.seen;
      expect(request!.path).toBe('/v1/messages');
      expect(request!.headers['x-api-key']).toBe('test-key');
      expect(request!.body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 4_096, system: 'Extract.', messages: [{ role: 'user', content: 'Transcript' }] });
      expect(request!.body.output_config.format).toMatchObject({ type: 'json_schema', schema: { type: 'object', additionalProperties: false } });
    }));

  it.scopedLive('continues paused web-search turns with the unchanged assistant content and returns cited sources', () =>
    Effect.gen(function* () {
      const search = [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'retention controls' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.com/b', title: 'Option B', encrypted_content: 'enc', page_age: null }] },
      ];
      const citation = { type: 'web_search_result_location', url: 'https://example.com/b', title: 'Option B', encrypted_index: 'idx', cited_text: 'retention controls' };
      const server = yield* replayServer([
        message(search, 'pause_turn'),
        message([{ type: 'text', text: 'Option B supports retention controls.', citations: [citation, citation] }]),
      ]);
      const result = yield* withAnthropic(server.url).research({ system: 'Research.', prompt: 'Which option supports retention?' });
      expect(result).toEqual({ model: 'claude-sonnet-5-5', value: { text: 'Option B supports retention controls.', sources: [{ url: 'https://example.com/b', title: 'Option B' }] } });
      expect(server.seen[0]!.body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: budget.researchMaxSearches }]);
      expect(server.seen[1]!.body.messages).toEqual([{ role: 'user', content: 'Which option supports retention?' }, { role: 'assistant', content: search }]);
    }));

  it.scopedLive('stops after the continuation budget instead of looping', () =>
    Effect.gen(function* () {
      const paused = message([{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } }], 'pause_turn');
      const server = yield* replayServer(Array.from({ length: 10 }, () => paused));
      const failure = yield* Effect.flip(withAnthropic(server.url).research({ system: '', prompt: 'q' }));
      expect(failure).toMatchObject({ retryable: false, message: `research model: Anthropic research still paused after ${budget.researchMaxContinuations} continuations` });
      expect(server.seen).toHaveLength(budget.researchMaxContinuations + 1);
    }));

  it.scopedLive('streams text deltas through the official SDK', () =>
    Effect.gen(function* () {
      const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}`;
      const server = yield* replayServer([
        sse([
          event('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } } }),
          event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Noted, ' } }),
          event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Friday.' } }),
          event('content_block_stop', { index: 0 }),
          event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }),
          event('message_stop', {}),
        ]),
        json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
      ]);
      const llm = makeLlm({ ...roles, voice: { provider: 'anthropic', model: 'claude-haiku-4-5', reasoning: null } }, { anthropic: anthropic({ apiKey: 'test-key', baseUrl: server.url }) }, budget);
      const text = [...(yield* Stream.runCollect(llm.stream('voice', { system: 'Speak.', prompt: 'When?' })))].join('');
      expect(text).toBe('Noted, Friday.');
      expect(server.seen[0]!.body).toMatchObject({ model: 'claude-haiku-4-5', stream: true });
      const overloaded = yield* Effect.flip(Stream.runDrain(llm.stream('voice', { system: '', prompt: '' })));
      expect(overloaded).toMatchObject({ retryable: true, message: expect.stringMatching(/HTTP 529/) });
    }));
});

describe('LlmLive', () => {
  it.effect('reads explicit role overrides and treats absent keys as unconfigured', () =>
    Effect.gen(function* () {
      const env = new Map([['EXTRACTION_MODEL_PROVIDER', 'anthropic'], ['EXTRACTION_MODEL', 'claude-haiku-4-5']]);
      const llm = yield* Effect.provide(LlmClient, LlmLive.pipe(Layer.provide(Layer.setConfigProvider(ConfigProvider.fromMap(env)))));
      const failure = yield* Effect.flip(llm.generate('extraction', ask));
      expect(failure.message).toBe('extraction model provider anthropic is not configured (ANTHROPIC_API_KEY)');
      const invalid = yield* Effect.exit(Effect.provide(LlmClient, LlmLive.pipe(Layer.provide(Layer.setConfigProvider(ConfigProvider.fromMap(new Map([['RESEARCH_MODEL_PROVIDER', 'cerebras']])))))));
      expect(Exit.isFailure(invalid)).toBe(true);
    }));
});
