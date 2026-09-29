import { HttpServer } from '@effect/platform';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, Unauthenticated } from '@sanctum/contracts';
import { Context, Effect, Layer } from 'effect';
import { Authenticator } from '../src/auth.ts';
import { dbLayer } from '../src/db.ts';
import { serverLayer } from '../src/main.ts';
import { loadMigrations, migrate } from '../src/migrate.ts';
import { hear, meetingsOf, RATE, seedEpoch, seedListener } from './support/capture.ts';
import { createTestDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

/** Bearer `<name>` resolves to the matching fixture access. */
const authenticator = (tokens: Record<string, AccessScope>) =>
  Layer.succeed(Authenticator, {
    authenticate: request => {
      const access = tokens[(request.headers.authorization ?? '').replace('Bearer ', '')];
      return access ? Effect.succeed(access) : Effect.fail(new Unauthenticated({ message: 'no credentials' }));
    },
  });

const call = (base: string, token: string, method: string, path: string, body?: unknown) =>
  Effect.promise(async () => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  });

describe('MeetingsApi over HTTP', () => {
  it.scoped('lists, reads, closes, splits and transcribes meetings through the shared authorization path', () =>
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
      const fixture = yield* Effect.provide(
        Effect.gen(function* () {
          yield* migrate(loadMigrations());
          const [owner, device, member] = yield* seedWorkspace('Http', ['owner', 'device', 'member']);
          const listener = yield* seedListener(device!);
          const epoch = yield* seedEpoch(listener);
          yield* hear(listener, epoch, 0, 30, 'first topic is the launch date');
          yield* hear(listener, epoch, 30, 60, 'second topic is the hiring plan');
          const [other] = yield* seedWorkspace('Other', ['owner']);
          return { owner: owner!, member: member!, other: other!, epoch, meeting: (yield* meetingsOf(listener.workspace_id))[0]!.id };
        }),
        dbLayer(database.mysql),
      );
      const layer = serverLayer({ apiPort: 0, mysql: database.mysql }, authenticator({ owner: fixture.owner, member: fixture.member, other: fixture.other }));
      const address = Context.get(yield* Layer.build(layer), HttpServer.HttpServer).address;
      if (address._tag !== 'TcpAddress') throw new Error('expected TCP');
      const base = `http://127.0.0.1:${address.port}`;
      const { meeting, epoch } = fixture;

      const list = yield* call(base, 'owner', 'GET', '/meetings?limit=10');
      expect(list).toMatchObject({ status: 200, body: { meetings: [{ id: meeting, state: 'active', boundary_revision: 1 }], next_cursor: null } });
      expect((yield* call(base, 'member', 'GET', '/meetings')).body).toEqual({ meetings: [], next_cursor: null });
      expect((yield* call(base, 'member', 'GET', `/meetings/${meeting}`)).status).toBe(404);
      expect((yield* call(base, 'other', 'GET', `/meetings/${meeting}`)).status).toBe(404);
      expect((yield* call(base, 'nobody', 'GET', `/meetings/${meeting}`)).status).toBe(401);

      const transcript = yield* call(base, 'owner', 'GET', `/meetings/${meeting}/transcript?limit=1`);
      expect(transcript).toMatchObject({ status: 200, body: { boundary_revision: 1, segments: [{ text: 'first topic is the launch date' }] } });
      const rest = yield* call(base, 'owner', 'GET', `/meetings/${meeting}/transcript?limit=1&cursor=${transcript.body.next_cursor}`);
      expect(rest.body).toMatchObject({ segments: [{ text: 'second topic is the hiring plan' }], next_cursor: null });

      expect((yield* call(base, 'owner', 'POST', `/meetings/${meeting}/close`)).body).toMatchObject({ state: 'closing' });
      const split = yield* call(base, 'owner', 'POST', `/meetings/${meeting}/split`, { expected_revision: 1, at: { epoch_id: epoch, sample: 30 * RATE } });
      expect(split).toMatchObject({ status: 200, body: { earlier: { id: meeting, boundary_revision: 2 }, later: { boundary_revision: 1 } } });
      const stale = yield* call(base, 'owner', 'POST', `/meetings/${meeting}/split`, { expected_revision: 1, at: { epoch_id: epoch, sample: 10 * RATE } });
      expect(stale).toMatchObject({ status: 409, body: { code: 'revision_conflict', current_revision: 2 } });
      const oldCursor = yield* call(base, 'owner', 'GET', `/meetings/${meeting}/transcript?cursor=${transcript.body.next_cursor}`);
      expect(oldCursor).toMatchObject({ status: 409, body: { current_revision: 2 } });
      const merged = yield* call(base, 'owner', 'POST', '/meetings/merge', { target: { meeting_id: meeting, expected_revision: 2 }, source: { meeting_id: split.body.later.id, expected_revision: 1 } });
      expect(merged).toMatchObject({ status: 200, body: { id: meeting, boundary_revision: 3 } });
      // No recording store is configured in this process, so playback reports it instead of inventing a URL.
      expect(yield* call(base, 'owner', 'POST', `/meetings/${meeting}/recording-access`)).toMatchObject({ status: 503, body: { code: 'unavailable', retryable: false } });
    }),
  );
});
