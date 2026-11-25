import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { d1Gate } from '../src/d1-gate.ts';

/** The gateway over a real local D1 (Miniflare through wrangler's platform proxy), speaking the protocol `server/src/db-d1.ts` uses. */
let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href),
    persist: { path: mkdtempSync(join(tmpdir(), 'd1-gate-')) },
  });
  db = proxy.env.DB;
  dispose = proxy.dispose;
  await db.exec('CREATE TABLE gate_test (id INTEGER PRIMARY KEY, name TEXT NOT NULL, blob BLOB)');
}, 60_000);

afterAll(async () => dispose());

const post = (path: string, body: unknown) => d1Gate(new Request(`http://d1.internal${path}`, { method: 'POST', body: JSON.stringify(body) }), db);
const run = (sql: string, params: unknown[] = []) => post('/run', { sql, params });
const count = async () => ((await (await run('SELECT count(*) AS n FROM gate_test')).json()) as { rows: { n: number }[] }).rows[0]?.n;

// Each call crosses into workerd, which is slow on a loaded CI host.
describe('D1 gateway', { timeout: 60_000 }, () => {
  it('runs one statement and returns rows and the change count', async () => {
    const insert = await run('INSERT INTO gate_test (id, name) VALUES (?, ?)', [1, 'one']);
    expect(await insert.json()).toEqual({ rows: [], changes: 1 });
    const select = await run('SELECT id, name FROM gate_test WHERE id = ?', [1]);
    expect(await select.json()).toEqual({ rows: [{ id: 1, name: 'one' }], changes: 0 });
  });

  it('carries bytes as base64 in both directions', async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const $b = Buffer.from(bytes).toString('base64');
    await run('INSERT INTO gate_test (id, name, blob) VALUES (?, ?, ?)', [2, 'bytes', { $b }]);
    const select = await run('SELECT blob FROM gate_test WHERE id = 2');
    expect(await select.json()).toEqual({ rows: [{ blob: { $b } }], changes: 0 });
  });

  it('commits a batch together and rolls the whole batch back when one statement fails', async () => {
    const before = await count();
    const ok = await post('/batch', { statements: [{ sql: 'INSERT INTO gate_test (id, name) VALUES (?, ?)', params: [10, 'a'] }, { sql: 'INSERT INTO gate_test (id, name) VALUES (?, ?)', params: [11, 'b'] }] });
    expect(await ok.json()).toEqual({ results: [{ rows: [], changes: 1 }, { rows: [], changes: 1 }] });
    expect(await count()).toBe(before! + 2);

    const failed = await post('/batch', { statements: [{ sql: 'INSERT INTO gate_test (id, name) VALUES (?, ?)', params: [12, 'c'] }, { sql: 'INSERT INTO gate_test (id, name) VALUES (?, ?)', params: [10, 'duplicate'] }] });
    expect(failed.status).toBe(400);
    expect(((await failed.json()) as { error: string }).error).toMatch(/UNIQUE constraint failed/);
    expect(await count()).toBe(before! + 2);
  });

  it('answers 400 with the D1 message for a failing statement and for a malformed body', async () => {
    const bad = await run('INSERT INTO gate_test (id, name) VALUES (?, ?)', [99, null]);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/NOT NULL constraint failed/);
    expect((await post('/run', { sql: 1 })).status).toBe(400);
    expect((await post('/batch', { statements: [{ sql: 'SELECT 1' }] })).status).toBe(400);
  });

  it('serves only POST /run and POST /batch', async () => {
    expect((await d1Gate(new Request('http://d1.internal/run'), db)).status).toBe(405);
    expect((await post('/other', {})).status).toBe(404);
  });
});
