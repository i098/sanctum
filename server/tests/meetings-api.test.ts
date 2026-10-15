import { HttpServer } from '@effect/platform';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, Unauthenticated } from '@sanctum/contracts';
import { Context, Effect, Layer } from 'effect';
import { Authenticator, ROLE_SCOPES } from '../src/auth.ts';
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
      for (const cursor of ['not-json', '[1,-1]', '[1,0.5]', '[1,9007199254740993]', '[-1,0]']) {
        const bad = yield* call(base, 'owner', 'GET', `/meetings/${meeting}/transcript?cursor=${Buffer.from(cursor).toString('base64url')}`);
        expect(bad).toMatchObject({ status: 404 });
      }

      expect((yield* call(base, 'owner', 'POST', `/meetings/${meeting}/close`)).body).toMatchObject({ state: 'closing' });
      const split = yield* call(base, 'owner', 'POST', `/meetings/${meeting}/split`, { expected_revision: 1, at: { epoch_id: epoch, sample: 30 * RATE } });
      expect(split).toMatchObject({ status: 200, body: { earlier: { id: meeting, boundary_revision: 2 }, later: { boundary_revision: 1 } } });
      const stale = yield* call(base, 'owner', 'POST', `/meetings/${meeting}/split`, { expected_revision: 1, at: { epoch_id: epoch, sample: 10 * RATE } });
      expect(stale).toMatchObject({ status: 409, body: { code: 'revision_conflict', current_revision: 2 } });
      const oldCursor = yield* call(base, 'owner', 'GET', `/meetings/${meeting}/transcript?cursor=${transcript.body.next_cursor}`);
      expect(oldCursor).toMatchObject({ status: 409, body: { current_revision: 2 } });
      const merged = yield* call(base, 'owner', 'POST', '/meetings/merge', { target: { meeting_id: meeting, expected_revision: 2 }, source: { meeting_id: split.body.later.id, expected_revision: 1 } });
      expect(merged).toMatchObject({ status: 200, body: { id: meeting, boundary_revision: 3 } });
      // No worker runs in this process, so the revised cut is not assembled yet: playback says so instead of inventing a URL.
      expect(yield* call(base, 'owner', 'POST', `/meetings/${meeting}/recording-access`)).toMatchObject({
        status: 503,
        body: { code: 'unavailable', retryable: true, message: 'The recording for boundary revision 3 is not assembled yet' },
      });
    }),
  );

  it.scoped('ends a meeting with a fence over HTTP, only for the principal that owns the listener', () =>
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
      const fixture = yield* Effect.provide(
        Effect.gen(function* () {
          yield* migrate(loadMigrations());
          const [owner, device] = yield* seedWorkspace('End', ['owner', 'device']);
          const listener = yield* seedListener(device!);
          const epoch = yield* seedEpoch(listener);
          yield* hear(listener, epoch, 0, 30, 'first topic is the launch date');
          return { owner: owner!, device: device!, epoch, meeting: (yield* meetingsOf(listener.workspace_id))[0]!.id };
        }),
        dbLayer(database.mysql),
      );
      const layer = serverLayer({ apiPort: 0, mysql: database.mysql }, authenticator({ owner: fixture.owner, device: fixture.device }));
      const address = Context.get(yield* Layer.build(layer), HttpServer.HttpServer).address;
      if (address._tag !== 'TcpAddress') throw new Error('expected TCP');
      const base = `http://127.0.0.1:${address.port}`;
      const { meeting, epoch } = fixture;

      expect((yield* call(base, 'device', 'POST', `/meetings/${meeting}/end`, { epoch_id: epoch })).status).toBe(400);
      expect((yield* call(base, 'owner', 'POST', `/meetings/${meeting}/end`, {})).status).toBe(403);
      expect((yield* call(base, 'owner', 'POST', `/meetings/${meeting}/end`, { epoch_id: epoch, fence_sample: 40 * RATE })).status).toBe(403);
      expect((yield* call(base, 'device', 'POST', `/meetings/${meeting}/end`, { epoch_id: epoch, fence_sample: 40 * RATE })).body).toMatchObject({ id: meeting, state: 'closing' });
    }),
  );

  it.scoped('shares a device-captured meeting with the workspace through a workspace owner, and restricts it again', () =>
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
      const fixture = yield* Effect.provide(
        Effect.gen(function* () {
          yield* migrate(loadMigrations());
          const [owner, device, member, agent] = (yield* seedWorkspace('Share', ['owner', 'device', 'member', 'agent'])).map(access => ({ ...access, scopes: ROLE_SCOPES[access.role] }));
          const listener = yield* seedListener(device!);
          const epoch = yield* seedEpoch(listener);
          yield* hear(listener, epoch, 0, 30, 'first topic is the launch date');
          const [other] = yield* seedWorkspace('Elsewhere', ['owner']);
          const reader: AccessScope = { ...agent!, scopes: ['context:read'] };
          return { owner: owner!, device: device!, member: member!, reader, other: other!, epoch, meeting: (yield* meetingsOf(listener.workspace_id))[0]!.id };
        }),
        dbLayer(database.mysql),
      );
      const layer = serverLayer({ apiPort: 0, mysql: database.mysql }, authenticator({ owner: fixture.owner, device: fixture.device, member: fixture.member, reader: fixture.reader, other: fixture.other }));
      const address = Context.get(yield* Layer.build(layer), HttpServer.HttpServer).address;
      if (address._tag !== 'TcpAddress') throw new Error('expected TCP');
      const base = `http://127.0.0.1:${address.port}`;
      const { meeting, epoch } = fixture;
      const share = (token: string, visibility: string) => call(base, token, 'POST', `/meetings/${meeting}/share`, { visibility });

      expect((yield* call(base, 'reader', 'GET', `/meetings/${meeting}/transcript`)).status).toBe(404);
      expect((yield* share('member', 'workspace')).status).toBe(404);
      expect((yield* share('other', 'workspace')).status).toBe(404);
      expect((yield* share('reader', 'workspace')).status).toBe(403);
      // The capturing device owns the meeting but holds only capture:ingest, so it cannot share.
      expect((yield* share('device', 'workspace')).status).toBe(403);
      expect((yield* call(base, 'reader', 'GET', `/meetings/${meeting}/transcript`)).status).toBe(404);

      expect((yield* share('owner', 'everyone')).status).toBe(400);
      expect((yield* share('owner', 'workspace')).body).toMatchObject({ id: meeting, visibility: 'workspace' });
      for (const token of ['reader', 'member']) {
        expect((yield* call(base, token, 'GET', `/meetings/${meeting}/transcript`)).body).toMatchObject({ segments: [{ text: 'first topic is the launch date' }] });
      }
      expect((yield* call(base, 'reader', 'GET', '/meetings')).body).toMatchObject({ meetings: [{ id: meeting }] });
      expect((yield* call(base, 'other', 'GET', `/meetings/${meeting}`)).status).toBe(404);
      // Sharing grants reads only: a member holding write scopes still cannot change the meeting.
      expect((yield* call(base, 'member', 'POST', `/meetings/${meeting}/split`, { expected_revision: 1, at: { epoch_id: epoch, sample: 10 * RATE } })).status).toBe(404);

      // Readers see the meeting but cannot change who else does.
      expect((yield* share('reader', 'restricted')).status).toBe(403);
      expect((yield* share('member', 'restricted')).status).toBe(403);

      expect((yield* share('owner', 'restricted')).body).toMatchObject({ visibility: 'restricted' });
      expect((yield* call(base, 'reader', 'GET', `/meetings/${meeting}/transcript`)).status).toBe(404);
    }),
  );
});
