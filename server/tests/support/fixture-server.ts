/**
 * Database-free v1 server over the fake domain, for SDK example tests outside the MySQL harness
 * (the Python SDK job). Seeds one workspace owner, a meeting and a transcript segment, then
 * prints `{ url, token, meeting_id }` as one JSON line and serves until killed.
 */
import { createServer } from 'node:http';
import { HttpApiBuilder, HttpServer } from '@effect/platform';
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node';
import { Unavailable } from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Context, Effect, Layer } from 'effect';
import { OpenApiLive } from '../../src/api.ts';
import { fakeApi, fakeDomain } from './fake-domain.ts';
import { fixtureAccess } from './fixtures.ts';

const HealthWithoutDatabase = HttpApiBuilder.group(SanctumApi, 'health', handlers =>
  handlers
    .handle('healthz', () => Effect.succeed({ status: 'ok' as const }))
    .handle('readyz', () => Effect.fail(new Unavailable({ message: 'Fixture server has no database', retryable: false }))),
);

export const fixtureServer = Effect.gen(function* () {
  const domain = fakeDomain();
  const owner = fixtureAccess({ role: 'owner' });
  const meeting = domain.addMeeting(owner, 'Fixture planning meeting');
  domain.addSegment(owner, meeting.id, 'We chose option B for the pilot.');
  const layer = HttpApiBuilder.serve().pipe(
    Layer.provide(OpenApiLive),
    Layer.provide(fakeApi(domain, HealthWithoutDatabase)),
    Layer.provide(domain.authenticator),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: '127.0.0.1' })),
  );
  const address = Context.get(yield* Layer.build(layer), HttpServer.HttpServer).address;
  if (address._tag !== 'TcpAddress') throw new Error('expected TCP');
  return { url: `http://127.0.0.1:${address.port}`, token: domain.token(owner), meeting_id: meeting.id, domain, owner };
});

if (import.meta.main) {
  Effect.gen(function* () {
    const { url, token, meeting_id } = yield* fixtureServer;
    console.log(JSON.stringify({ url, token, meeting_id }));
    return yield* Effect.never;
  }).pipe(Effect.scoped, NodeRuntime.runMain);
}
