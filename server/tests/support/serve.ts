/** The real API process layer on a free port over a migrated test database and the fake domain. */
import { HttpServer } from '@effect/platform';
import { Context, Effect, Layer, Option } from 'effect';
import { dbLayer } from '../../src/db.ts';
import { serverLayer } from '../../src/main.ts';
import { type McpAuthorization, McpAuthorizationServer } from '../../src/mcp.ts';
import { loadMigrations, migrate } from '../../src/migrate.ts';
import { createTestDatabase } from './database.ts';
import { fakeApi, fakeDomain } from './fake-domain.ts';

export const serveFake = (mcp: Option.Option<McpAuthorization> = Option.none()) =>
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
    const db = dbLayer(database.mysql);
    yield* Effect.provide(migrate(loadMigrations()), db);
    const domain = fakeDomain();
    const layer = serverLayer({ apiPort: 0, mysql: database.mysql }, domain.authenticator, {
      api: fakeApi(domain),
      mcp: Layer.succeed(McpAuthorizationServer, mcp),
    });
    const address = Context.get(yield* Layer.build(layer), HttpServer.HttpServer).address;
    if (address._tag !== 'TcpAddress') throw new Error('expected TCP');
    return { url: `http://127.0.0.1:${address.port}`, domain, db };
  });
