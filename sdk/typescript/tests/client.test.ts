import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createClient, type OperationId, pages, SanctumError, waitForAction } from '../src/index.ts';

interface Exchange {
  readonly request: { readonly method: string; readonly path: string; readonly query: Record<string, string>; readonly body: unknown };
  readonly response: { readonly status: number; readonly body: unknown };
}
interface WireCase {
  readonly name: string;
  readonly operation: OperationId;
  readonly input: never;
  readonly exchanges: ReadonlyArray<Exchange>;
  readonly result: { readonly ok?: Record<string, unknown> | null; readonly error?: Record<string, unknown> };
}
const fixture: { token: string; cases: ReadonlyArray<WireCase> } = JSON.parse(
  readFileSync(new URL('../../fixtures/wire-cases.json', import.meta.url), 'utf8'),
);

/** Replays golden exchanges in order and records what the client actually sent. */
function replay(exchanges: ReadonlyArray<Exchange>) {
  const sent: Array<Exchange['request'] & { authorization: string | null }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    sent.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      authorization: headers.get('authorization'),
    });
    const next = exchanges[sent.length - 1];
    if (next === undefined) throw new Error('Unexpected extra request');
    const body = next.response.body === null ? null : JSON.stringify(next.response.body);
    return new Response(body, { status: next.response.status, headers: { 'content-type': 'application/json' } });
  };
  return { sent, fetch };
}

describe('TypeScript SDK wire behavior (shared with the Python SDK)', () => {
  it.each(fixture.cases.map(c => [c.name, c] as const))('%s', async (_name, wireCase) => {
    const { sent, fetch } = replay(wireCase.exchanges);
    const client = createClient({ baseUrl: 'https://sanctum.test', token: fixture.token, fetch, retryDelayMs: 1 });
    const outcome = await client.call(wireCase.operation, wireCase.input).then(
      ok => ({ ok }),
      (error: unknown) => ({ error }),
    );
    expect(sent).toEqual(wireCase.exchanges.map(e => ({ ...e.request, authorization: `Bearer ${fixture.token}` })));
    if ('ok' in wireCase.result) expect(outcome).toMatchObject({ ok: wireCase.result.ok });
    else {
      const { status, code, retryable, ...details } = wireCase.result.error!;
      expect('error' in outcome && outcome.error).toBeInstanceOf(SanctumError);
      expect('error' in outcome && outcome.error).toMatchObject({ status, code, retryable, body: details });
    }
  });
});

describe('TypeScript SDK transport', () => {
  const page = (meetings: ReadonlyArray<number>, next_cursor: string | null) => ({ meetings, next_cursor });

  it('retries a read after a network failure and stops after maxAttempts', async () => {
    let calls = 0;
    const flaky = createClient({
      baseUrl: 'https://sanctum.test',
      retryDelayMs: 1,
      fetch: async () => (++calls < 3 ? Promise.reject(new TypeError('fetch failed')) : Response.json({ status: 'ok' })),
    });
    await expect(flaky.health.healthz({})).resolves.toEqual({ status: 'ok' });
    expect(calls).toBe(3);

    calls = 0;
    const down = createClient({ baseUrl: 'https://sanctum.test', retryDelayMs: 1, maxAttempts: 2, fetch: async () => (calls++, Promise.reject(new TypeError('fetch failed'))) });
    await expect(down.health.healthz({})).rejects.toThrow('fetch failed');
    expect(calls).toBe(2);
  });

  it('turns a non-JSON proxy error into SanctumError with its status and retries a read through it', async () => {
    let calls = 0;
    const client = createClient({
      baseUrl: 'https://sanctum.test',
      retryDelayMs: 1,
      fetch: async () => (++calls < 3 ? new Response('<html>Bad Gateway</html>', { status: 502 }) : Response.json({ status: 'ok' })),
    });
    await expect(client.health.healthz({})).resolves.toEqual({ status: 'ok' });
    expect(calls).toBe(3);

    const down = createClient({ baseUrl: 'https://sanctum.test', maxAttempts: 1, fetch: async () => new Response('<html>Bad Gateway</html>', { status: 502 }) });
    await expect(down.health.healthz({})).rejects.toMatchObject({ name: 'SanctumError', status: 502, code: 'http_error', retryable: true, body: {} });
  });

  it('aborts an in-flight request without retrying', async () => {
    let calls = 0;
    const client = createClient({
      baseUrl: 'https://sanctum.test',
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          calls++;
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    const controller = new AbortController();
    const pending = client.health.healthz({}, { signal: controller.signal });
    controller.abort(new DOMException('stop', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('pages follow next_cursor and stop on a null cursor or an empty page', async () => {
    const cursors: Array<string | null> = [];
    const responses = [page([1, 2], 'o2'), page([3], 'o3'), page([], 'o3')];
    const client = createClient({
      baseUrl: 'https://sanctum.test',
      fetch: async input => (cursors.push(new URL(String(input)).searchParams.get('cursor')), Response.json(responses.shift())),
    });
    const seen: unknown[] = [];
    for await (const p of pages(client, 'meetings.listMeetings', { limit: 2 })) seen.push(...p.meetings);
    expect(seen).toEqual([1, 2, 3]);
    expect(cursors).toEqual([null, 'o2', 'o3']);
  });

  it('waits for a terminal action receipt', async () => {
    const states = ['queued', 'running', 'succeeded'];
    const client = createClient({
      baseUrl: 'https://sanctum.test',
      fetch: async () => Response.json({ action_id: 'a', state: states.shift() }),
    });
    await expect(waitForAction(client, 'a', { intervalMs: 1 })).resolves.toMatchObject({ state: 'succeeded' });
    expect(states).toEqual([]);
  });
});
