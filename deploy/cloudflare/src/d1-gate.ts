/**
 * The container's door to D1 (plan section 04). The container sends plain HTTP to `d1.internal`; the outbound
 * intercept in index.ts hands the request to this handler, so no token is in the container and no public route
 * reaches it. Protocol, as `server/src/db-d1.ts` speaks it:
 *   POST /run    {sql, params}        -> {rows, changes}
 *   POST /batch  {statements: [...]}  -> {results: [{rows, changes}]}   (one transaction: all or none)
 * Bytes travel as `{"$b":"<base64>"}` in both directions. A D1 error answers 400 `{error}`.
 */

interface Statement {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
}

const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
};

const fromBase64 = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));

const isBytes = (value: unknown): value is { readonly $b: string } =>
  typeof value === 'object' && value !== null && '$b' in value && typeof value.$b === 'string';

/** Bound bytes go to D1 as an ArrayBuffer. */
const decodeParam = (value: unknown) => (isBytes(value) ? fromBase64(value.$b).buffer : value);

/** D1 returns a BLOB as an array of byte numbers; no other column value is an array. */
const encodeValue = (value: unknown) => (Array.isArray(value) ? { $b: toBase64(Uint8Array.from(value)) } : value);

const encodeResult = (result: D1Result<Record<string, unknown>>) => ({
  rows: result.results.map(row => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, encodeValue(value)]))),
  changes: result.meta.changes,
});

const isStatement = (value: unknown): value is Statement =>
  typeof value === 'object' && value !== null && 'sql' in value && typeof value.sql === 'string' && 'params' in value && Array.isArray(value.params);

const reply = (status: number, body: unknown) => Response.json(body, { status });

export const d1Gate = async (request: Request, db: D1Database): Promise<Response> => {
  const path = new URL(request.url).pathname;
  if (path !== '/run' && path !== '/batch') return reply(404, { error: 'not found' });
  if (request.method !== 'POST') return reply(405, { error: 'POST only' });
  const prepare = ({ sql, params }: Statement) => db.prepare(sql).bind(...params.map(decodeParam));
  try {
    const body: unknown = await request.json();
    if (path === '/run') {
      if (!isStatement(body)) return reply(400, { error: 'expected {sql, params}' });
      return reply(200, encodeResult(await prepare(body).run()));
    }
    const statements = typeof body === 'object' && body !== null && 'statements' in body ? body.statements : undefined;
    if (!Array.isArray(statements) || !statements.every(isStatement)) return reply(400, { error: 'expected {statements: [{sql, params}]}' });
    return reply(200, { results: (await db.batch<Record<string, unknown>>(statements.map(prepare))).map(encodeResult) });
  } catch (error) {
    return reply(400, { error: error instanceof Error ? error.message : String(error) });
  }
};
