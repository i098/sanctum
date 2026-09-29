import { describe, expect, it } from '@effect/vitest';
import { Unauthenticated } from '@sanctum/contracts';
import { Effect, Layer } from 'effect';
import { Authenticator } from '../src/auth.ts';
import { engineeringDefaults, requireActivation } from '../src/config.ts';
import { fixtureAccess } from './support/fixtures.ts';
import { serveApi } from './http-server.ts';

const access = fixtureAccess();

/** Fixture authenticator: bearer `fixture` resolves to `access`; anything else is unauthenticated. */
const FixtureAuthenticator = Layer.succeed(Authenticator, {
  authenticate: request =>
    request.headers.authorization === 'Bearer fixture' ? Effect.succeed(access) : Effect.fail(new Unauthenticated({ message: 'no credentials' })),
});

const get = (url: string, headers: Record<string, string> = {}) =>
  Effect.promise(async () => {
    const response = await fetch(url, { headers });
    return { status: response.status, body: await response.json() };
  });

describe('API entrypoint', () => {
  it.scoped('serves health, readiness and the authenticated session over HTTP', () =>
    Effect.gen(function* () {
      const base = yield* serveApi({ auth: FixtureAuthenticator });
      expect(yield* get(`${base}/healthz`)).toEqual({ status: 200, body: { status: 'ok' } });
      expect(yield* get(`${base}/readyz`)).toEqual({ status: 200, body: { status: 'ready' } });
      expect(yield* get(`${base}/api/v1/session`, { authorization: 'Bearer fixture' })).toEqual({ status: 200, body: access });
      const denied = yield* get(`${base}/api/v1/session`, { authorization: 'Bearer other' });
      expect(denied).toEqual({ status: 401, body: { _tag: 'Unauthenticated', code: 'unauthenticated', retryable: false, message: 'no credentials' } });
    }),
  );

  it.scoped('is not ready while migrations are pending and never grants a session without the credential tables', () =>
    Effect.gen(function* () {
      const base = yield* serveApi({ migrated: false });
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
