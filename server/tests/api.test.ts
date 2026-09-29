import { HttpServer } from '@effect/platform';
import { describe, expect, it } from '@effect/vitest';
import { Unauthenticated } from '@sanctum/contracts';
import { Context, Effect, Layer } from 'effect';
import { Authenticator } from '../src/auth.ts';
import { engineeringDefaults, requireActivation } from '../src/config.ts';
import { serverLayer } from '../src/main.ts';
import { migrate, loadMigrations } from '../src/migrate.ts';
import { dbLayer } from '../src/db.ts';
import { createTestDatabase } from './support/database.ts';
import { fixtureAccess } from './support/fixtures.ts';

const access = fixtureAccess();

/** Fixture authenticator: bearer `fixture` resolves to `access`; anything else is unauthenticated. */
const FixtureAuthenticator = Layer.succeed(Authenticator, {
  authenticate: request =>
    request.headers.authorization === 'Bearer fixture' ? Effect.succeed(access) : Effect.fail(new Unauthenticated({ message: 'no credentials' })),
});

/** Real Node HTTP server on a free port against a disposable database; yields its base URL. */
const serve = (options: { readonly migrated: boolean; readonly auth?: Layer.Layer<Authenticator> }) =>
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
    if (options.migrated) yield* Effect.provide(migrate(loadMigrations()), dbLayer(database.mysql));
    const layer = serverLayer({ apiPort: 0, mysql: database.mysql }, options.auth);
    const context = yield* Layer.build(layer);
    const address = Context.get(context, HttpServer.HttpServer).address;
    if (address._tag !== 'TcpAddress') throw new Error('expected TCP');
    return `http://127.0.0.1:${address.port}`;
  });

const get = (url: string, headers: Record<string, string> = {}) =>
  Effect.promise(async () => {
    const response = await fetch(url, { headers });
    return { status: response.status, body: await response.json() };
  });

describe('API entrypoint', () => {
  it.scoped('serves health, readiness and the authenticated session over HTTP', () =>
    Effect.gen(function* () {
      const base = yield* serve({ migrated: true, auth: FixtureAuthenticator });
      expect(yield* get(`${base}/healthz`)).toEqual({ status: 200, body: { status: 'ok' } });
      expect(yield* get(`${base}/readyz`)).toEqual({ status: 200, body: { status: 'ready' } });
      expect(yield* get(`${base}/api/v1/session`, { authorization: 'Bearer fixture' })).toEqual({ status: 200, body: access });
      const denied = yield* get(`${base}/api/v1/session`, { authorization: 'Bearer other' });
      expect(denied).toEqual({ status: 401, body: { _tag: 'Unauthenticated', code: 'unauthenticated', retryable: false, message: 'no credentials' } });
    }),
  );

  it.scoped('is not ready while migrations are pending and never grants a session without the credential tables', () =>
    Effect.gen(function* () {
      const base = yield* serve({ migrated: false });
      const ready = yield* get(`${base}/readyz`);
      expect(ready.status).toBe(503);
      expect(ready.body).toMatchObject({ code: 'unavailable', retryable: true });
      // The kernel authenticator cannot read its tables: a server error, never an unchecked grant.
      const session = yield* Effect.promise(() => fetch(`${base}/api/v1/session`, { headers: { authorization: 'Bearer fixture' } }));
      expect(session.status).toBe(500);
    }),
  );

  it.effect('refuses production activation while open decisions are unselected', () =>
    Effect.gen(function* () {
      yield* requireActivation({ environment: 'development', selectedDecisions: [] });
      const blocked = yield* Effect.flip(requireActivation({ environment: 'production', selectedDecisions: ['identity_issuer'] }));
      expect(blocked.message).toBe('Production activation blocked; unselected: mcp_authorization_server, meeting_retention, outside_meeting_speech');
      yield* requireActivation({ environment: 'production', selectedDecisions: ['identity_issuer', 'mcp_authorization_server', 'meeting_retention', 'outside_meeting_speech'] });
    }),
  );

  it('keeps plan section 02 engineering defaults in one configuration object', () => {
    expect(engineeringDefaults).toMatchObject({ archiveChunkSeconds: 30, browserCommitIntervalMs: 2_000, playbackUrlTtlMs: 300_000, recordingExpiry: null });
    expect(engineeringDefaults.ownershipLeaseMs).toBe(3 * engineeringDefaults.heartbeatIntervalMs);
    expect(engineeringDefaults.contextJob).toEqual({ quietPeriodMs: 25_000, turnThreshold: 4 });
    expect(engineeringDefaults.boundaryEvaluationGapMs).toBe(5 * 60_000);
  });
});
