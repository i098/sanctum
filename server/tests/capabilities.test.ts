import { createHash, randomUUID } from 'node:crypto';
import { HttpApi, HttpServer } from '@effect/platform';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, Authenticated, ProfileId, Unauthenticated } from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Context, Effect, Layer } from 'effect';
import { Authenticator } from '../src/auth.ts';
import { dbLayer } from '../src/db.ts';
import { fixtureLlm } from '../src/llm.ts';
import { serverLayer } from '../src/main.ts';
import { storeEmbedding } from '../src/matcher.ts';
import { summarizeNotes } from '../src/notes-job.ts';
import { seedMeeting, seedSegment } from './support/context.ts';
import { loadMigrations, migrate, pendingMigrations, requireCurrentSchema } from '../src/migrate.ts';
import { createTestDatabase, withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';
import { SHELL, builtWebsite, rawRequest, serveApi } from './http-server.ts';

/** Every authenticated operation in the v1 contract, with path parameters filled by fresh UUIDs. */
const authenticatedRoutes = () => {
  const routes: Array<{ readonly name: string; readonly method: string; readonly path: string }> = [];
  HttpApi.reflect(SanctumApi, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, middleware }) => {
      if ([...middleware].some(tag => tag.key === Authenticated.key)) routes.push({ name: endpoint.name, method: endpoint.method, path: endpoint.path.replace(/:\w+/g, () => randomUUID()) });
    },
  });
  return routes;
};

describe('capabilities under the served application', () => {
  it.scoped('opens meeting deep links in the website while API meeting paths never return the shell', () =>
    Effect.gen(function* () {
      const base = yield* serveApi({ webRoot: yield* builtWebsite });
      const meeting = randomUUID();
      for (const path of [`/meetings/${meeting}`, `/meetings/${meeting}/transcript?at=2026-09-26T17:08:16Z`]) {
        const link = yield* rawRequest(base, path);
        expect(link, path).toMatchObject({ status: 200, body: SHELL });
        expect(link.headers['permissions-policy'], path).toContain('microphone=(self)');
      }
      const api = yield* rawRequest(base, `/api/v1/meetings/${meeting}`);
      expect(api.body).not.toContain('<!doctype html>');
    }),
  );

  it.scoped('refuses every authenticated capability without credentials', () =>
    Effect.gen(function* () {
      const base = yield* serveApi();
      const routes = authenticatedRoutes();
      expect(routes.map(route => route.name)).toContain('getSession');
      for (const route of routes) {
        const response = yield* rawRequest(base, route.path, route.method);
        expect({ route: route.name, status: response.status }).toEqual({ route: route.name, status: 401 });
        expect(JSON.parse(response.body)).toMatchObject({ code: 'unauthenticated' });
      }
    }),
  );

  it.effect('rehearses rollback to the previous release with recorded sources and action receipts intact', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const migrations = loadMigrations();
        const previousRelease = migrations.slice(0, -1);
        const [owner, device] = yield* seedWorkspace('Rollback rehearsal', ['owner', 'device']);
        const workspace = owner!.workspace_id;
        const listener = randomUUID();
        const epoch = randomUUID();
        const chunk = randomUUID();
        const action = randomUUID();
        const receipt = { provider: 'fixture', message_id: 'fixture-receipt-1' };
        yield* sql`INSERT INTO listeners (id, workspace_id, principal_id, name, mode, capabilities, created_at)
          VALUES (${listener}, ${workspace}, ${device!.principal.id}, 'Room', 'room', '{}', UTC_TIMESTAMP(6))`;
        yield* sql`INSERT INTO capture_epochs (id, workspace_id, listener_id, lease_generation, sample_rate, channels, encoding, sample_start,
            captured_at, timezone, start_reason, started_at, live_sample_end)
          VALUES (${epoch}, ${workspace}, ${listener}, 1, 48000, 1, 'pcm_s16le', 0, UTC_TIMESTAMP(6), 'America/Los_Angeles', 'start', UTC_TIMESTAMP(6), 1440000)`;
        yield* sql`INSERT INTO recording_chunks (id, workspace_id, listener_id, epoch_id, track, sequence, sample_start, sample_count, sample_rate,
            captured_at, byte_length, sha256, object_key, upload_state, created_at, committed_at)
          VALUES (${chunk}, ${workspace}, ${listener}, ${epoch}, 0, 0, 0, 1440000, 48000, UTC_TIMESTAMP(6), ${44 + 1440000 * 2},
            ${createHash('sha256').update('chunk').digest()}, ${`recordings/${chunk}.wav`}, 'committed', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
        yield* sql`INSERT INTO actions (id, workspace_id, requested_by, action_key, idempotency_key, args, args_sha256, state, provider_receipt, created_at, updated_at, version)
          VALUES (${action}, ${workspace}, ${owner!.principal.id}, 'gmail-send-email', 'rehearsal-1', '{}', ${createHash('sha256').update('{}').digest()},
            'succeeded', ${JSON.stringify(receipt)}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), '0.1.0')`;

        // The previous release runs against the current schema: nothing pending, nothing dropped.
        expect(yield* pendingMigrations(previousRelease)).toEqual([]);
        yield* requireCurrentSchema(previousRelease);
        // Rolling forward again is a no-op on the ledger.
        expect(yield* migrate(migrations)).toEqual({ applied: [], adopted: [] });

        const [chunkRow] = yield* sql<{ upload_state: string; object_key: string }>`SELECT upload_state, object_key FROM recording_chunks WHERE id = ${chunk}`;
        expect(chunkRow).toEqual({ upload_state: 'committed', object_key: `recordings/${chunk}.wav` });
        const [actionRow] = yield* sql<{ state: string; provider_receipt: unknown }>`SELECT state, provider_receipt FROM actions WHERE id = ${action}`;
        expect(actionRow).toEqual({ state: 'succeeded', provider_receipt: receipt });
      }),
      { migrated: true },
    ),
    // Migrates a fresh database and then re-runs the ledger check.
    60_000,
  );
});

/** Bearer `<name>` resolves to the matching fixture access. */
const tokens = (byName: Record<string, AccessScope>) =>
  Layer.succeed(Authenticator, {
    authenticate: request => {
      const access = byName[(request.headers.authorization ?? '').replace('Bearer ', '')];
      return access ? Effect.succeed(access) : Effect.fail(new Unauthenticated({ message: 'no credentials' }));
    },
  });

const get = (base: string, token: string, path: string) =>
  Effect.promise(async () => {
    const response = await fetch(`${base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  });

const notesAnswer = JSON.stringify({
  title: 'Launch review',
  summary: 'The launch moves to Friday.',
  sections: [{ heading: 'Decisions', points: [{ text: 'Launch moves to Friday.', segments: ['S1'] }] }],
});

const profile = (access: AccessScope, name: string, kind: 'needs' | 'offers', vector: number[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = ProfileId.make(randomUUID());
    yield* sql`INSERT INTO profiles (id, workspace_id, kind, display_name, details, created_at, updated_at)
      VALUES (${id}, ${access.workspace_id}, 'person', ${name}, '{}', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    yield* storeEmbedding(access, { profile_id: id, kind, vector, model: 'fixture-embed-v1', source_revision: 1 });
    return id;
  });

describe('T25 capabilities under the new access model', () => {
  it.scoped('serves notes, exports and matching to their workspace only', () =>
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
      const fixture = yield* Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* migrate(loadMigrations());
          const [owner, device] = yield* seedWorkspace('Acme', ['owner', 'device']);
          const [outsider] = yield* seedWorkspace('Rival', ['owner']);
          const meeting = yield* seedMeeting(device!, { started_at: '2026-09-28 16:00:00' });
          yield* seedSegment(meeting, 0, 4, 'We move the launch to Friday.');
          yield* sql`UPDATE meetings SET state = 'closed', ended_at = UTC_TIMESTAMP(6) WHERE id = ${meeting.meeting_id}`;
          yield* Effect.provide(summarizeNotes({ workspace_id: meeting.workspace_id, payload: { meeting_id: meeting.meeting_id } }), fixtureLlm([notesAnswer]));
          const seeker = yield* profile(owner!, 'Seeker', 'needs', [1, 0]);
          const helper = yield* profile(owner!, 'Helper', 'offers', [1, 0.1]);
          return { owner: owner!, outsider: outsider!, meeting: meeting.meeting_id, seeker, helper };
        }),
        dbLayer(database.mysql),
      );
      const server = serverLayer({ apiPort: 0, mysql: database.mysql }, tokens({ owner: fixture.owner, outsider: fixture.outsider }));
      const address = Context.get(yield* Layer.build(server), HttpServer.HttpServer).address;
      if (address._tag !== 'TcpAddress') throw new Error('expected TCP');
      const base = `http://127.0.0.1:${address.port}`;
      const { meeting, seeker, helper } = fixture;

      expect(yield* get(base, 'owner', `/meetings/${meeting}/notes`)).toMatchObject({ status: 200, body: { title: 'Launch review', revision: 1 } });
      const exported = yield* get(base, 'owner', `/meetings/${meeting}/export`);
      expect(exported).toMatchObject({ status: 200, body: { format: 'markdown', notes_revision: 1 } });
      expect(exported.body['content']).toContain('- Launch moves to Friday. (0:00)');
      expect(yield* get(base, 'owner', `/profiles/${seeker}/matches?kind=needs&top_k=5`)).toMatchObject({ status: 200, body: { matches: [{ profile_id: helper }] } });

      for (const path of [`/meetings/${meeting}/notes`, `/meetings/${meeting}/export`, `/profiles/${seeker}/matches?kind=needs`]) {
        expect((yield* get(base, 'outsider', path)).status, path).toBe(404);
      }
    }),
  );
});

