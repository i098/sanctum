import { HttpServer } from '@effect/platform';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, Unauthenticated } from '@sanctum/contracts';
import { Context, Effect, Layer } from 'effect';
import { Authenticator } from '../src/auth.ts';
import { dbLayer } from '../src/db.ts';
import { serverLayer } from '../src/main.ts';
import { loadMigrations, migrate } from '../src/migrate.ts';
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

describe('Onboarding over HTTP', () => {
  it.scoped('keeps completion per principal and lets only owners and admins rename the workspace', () =>
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
      const [owner, admin, member] = yield* Effect.provide(
        Effect.zipRight(migrate(loadMigrations()), seedWorkspace('Pilot', ['owner', 'admin', 'member'])),
        dbLayer(database.mysql),
      );
      // A member's session carries no workspace:admin (auth.ts ROLE_SCOPES); the fixture grants every scope.
      const plainMember = { ...member!, scopes: member!.scopes.filter(scope => scope !== 'workspace:admin') };
      const layer = serverLayer({ apiPort: 0, mysql: database.mysql }, authenticator({ owner: owner!, admin: admin!, member: plainMember }));
      const address = Context.get(yield* Layer.build(layer), HttpServer.HttpServer).address;
      if (address._tag !== 'TcpAddress') throw new Error('expected TCP');
      const call = (token: string, method: string, path: string, body?: unknown) =>
        Effect.promise(async () => {
          const response = await fetch(`http://127.0.0.1:${address.port}/api/v1${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          return { status: response.status, body: await response.json() };
        });

      expect(yield* call('owner', 'GET', '/onboarding')).toEqual({ status: 200, body: { completed: false, workspace_name: 'Pilot' } });
      expect((yield* call('nobody', 'GET', '/onboarding')).status).toBe(401);

      // Finishing or skipping is stored for the principal: every later read, from any session, sees it; a second one changes nothing.
      expect((yield* call('owner', 'POST', '/onboarding')).body).toEqual({ completed: true, workspace_name: 'Pilot' });
      expect((yield* call('owner', 'POST', '/onboarding')).body).toEqual({ completed: true, workspace_name: 'Pilot' });
      expect((yield* call('owner', 'GET', '/onboarding')).body).toEqual({ completed: true, workspace_name: 'Pilot' });
      expect((yield* call('member', 'GET', '/onboarding')).body).toEqual({ completed: false, workspace_name: 'Pilot' });

      expect((yield* call('member', 'POST', '/workspace/name', { name: 'Taken over' })).status).toBe(403);
      expect((yield* call('admin', 'POST', '/workspace/name', { name: '   ' })).status).toBe(400);
      expect((yield* call('admin', 'POST', '/workspace/name', { name: 'x'.repeat(201) })).status).toBe(400);
      expect(yield* call('admin', 'POST', '/workspace/name', { name: '  Acme Labs  ' })).toEqual({ status: 200, body: { completed: false, workspace_name: 'Acme Labs' } });
      expect((yield* call('member', 'GET', '/onboarding')).body).toEqual({ completed: false, workspace_name: 'Acme Labs' });
    }),
  );
});
