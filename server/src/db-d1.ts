/**
 * D1 backend: HTTP to the gateway Worker (`deploy/cloudflare/src/d1-gate.ts`) that the container reaches at
 * `http://d1.internal`. Bytes travel as `{"$b":"<base64>"}` in both directions.
 */
import { SqlError } from '@effect/sql';
import { Effect } from 'effect';
import type { DbBackend, DbResult, DbStatement } from './db-types.ts';

const encode = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return { $b: Buffer.from(value).toString('base64') };
  if (typeof value === 'boolean') return Number(value);
  return value === undefined ? null : value;
};

const decode = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && '$b' in value && typeof value.$b === 'string' ? new Uint8Array(Buffer.from(value.$b, 'base64')) : value;

const decodeResult = (result: DbResult): DbResult => ({
  changes: result.changes,
  rows: result.rows.map(row => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, decode(value)]))),
});

const toBody = ({ sql, params }: DbStatement) => ({ sql, params: params.map(encode) });

export const d1Backend = (baseUrl: string): DbBackend => {
  const post = <A>(path: string, body: unknown) =>
    Effect.tryPromise({
      try: async signal => {
        const response = await fetch(new URL(path, baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
        const payload = (await response.json()) as A & { readonly error?: string };
        if (!response.ok) throw new Error(payload.error ?? `D1 gateway answered ${response.status}`);
        return payload;
      },
      catch: cause => new SqlError.SqlError({ cause, message: cause instanceof Error ? cause.message : String(cause) }),
    });
  return {
    run: statement => Effect.map(post<DbResult>('/run', toBody(statement)), decodeResult),
    batch: statements => Effect.map(post<{ readonly results: ReadonlyArray<DbResult> }>('/batch', { statements: statements.map(toBody) }), payload => payload.results.map(decodeResult)),
  };
};
