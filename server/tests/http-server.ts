/** Real API server on a free port against a disposable migrated database, plus a built-website fixture. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpServer } from '@effect/platform';
import { Context, Effect, Layer } from 'effect';
import { dbLayer } from '../src/db.ts';
import { serverLayer } from '../src/main.ts';
import { loadMigrations, migrate } from '../src/migrate.ts';
import { createTestDatabase } from './support/database.ts';

export const SHELL = '<!doctype html><title>Sanctum</title><script type="module" src="/assets/index-abc123.js"></script>';

/** Scoped: a website build in `<tmp>/dist` next to `<tmp>/outside.txt`, which must never be served. */
export const builtWebsite = Effect.acquireRelease(
  Effect.sync(() => {
    const parent = mkdtempSync(join(tmpdir(), 'sanctum-web-'));
    const root = join(parent, 'dist');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), SHELL);
    writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log("listening")');
    writeFileSync(join(parent, 'outside.txt'), 'outside the web root');
    return root;
  }),
  root => Effect.sync(() => rmSync(join(root, '..'), { recursive: true, force: true })),
);

/** Scoped: the base URL and a layer on the same database; the server and database (migrated unless `migrated: false`) are removed with the scope. */
export const serveApiWithDb = (
  options: {
    readonly migrated?: boolean;
    readonly webRoot?: string;
    readonly auth?: Parameters<typeof serverLayer>[1];
    readonly overrides?: Parameters<typeof serverLayer>[2];
  } = {},
) =>
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
    const db = dbLayer(database.mysql);
    if (options.migrated !== false) yield* Effect.provide(migrate(loadMigrations()), db);
    const context = yield* Layer.build(serverLayer({ apiPort: 0, mysql: database.mysql, webRoot: options.webRoot }, options.auth, options.overrides));
    const address = Context.get(context, HttpServer.HttpServer).address;
    if (address._tag !== 'TcpAddress') throw new Error('expected TCP');
    return { base: `http://127.0.0.1:${address.port}`, db };
  });

/** Scoped: yields the base URL only. */
export const serveApi = (options: Parameters<typeof serveApiWithDb>[0] = {}) => Effect.map(serveApiWithDb(options), ({ base }) => base);

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** Sends the path byte-for-byte (fetch would normalize `..` and `%2e%2e`). */
export const rawRequest = (base: string, path: string, method = 'GET') =>
  Effect.async<RawResponse>(resume => {
    const req = request(new URL(base), { path, method }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => (body += chunk));
      response.on('end', () => resume(Effect.succeed({ status: response.statusCode ?? 0, headers: response.headers, body })));
    });
    req.on('error', error => resume(Effect.die(error)));
    req.end();
  });
