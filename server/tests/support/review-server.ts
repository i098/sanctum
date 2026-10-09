/**
 * Real API server for the website's Review end-to-end test: `serverLayer` from main.ts on a free
 * port over a disposable migrated database on `SANCTUM_TEST_MYSQL_URL`, seeded with one closed
 * meeting whose recording was assembled with a gap, context items, a committed memory revision
 * and an action receipt. A second port serves the in-memory object store behind the URLs the API
 * signs, refusing expired or unsigned ones. The owner signs in with a real browser session, so
 * cookie mutations need the CSRF header. Prints `{ url, objects, session, csrf }` as one JSON
 * line, serves until SIGTERM, then drops its database.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { HttpServer } from '@effect/platform';
import { SqlClient } from '@effect/sql';
import { MeetingId } from '@sanctum/contracts';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { KernelAuthenticatorLive, openSession } from '../../src/auth.ts';
import { addContextItem, getContextSnapshot, reviseContextItem } from '../../src/context.ts';
import { dbLayer } from '../../src/db.ts';
import { serverLayer } from '../../src/main.ts';
import { closeMeeting, finalizeMeeting } from '../../src/meetings.ts';
import { loadMigrations, migrate } from '../../src/migrate.ts';
import { assembleRecording } from '../../src/playback.ts';
import { SpeechToTextLive } from '../../src/media/providers.ts';
import { claimed, commitChunk, hear, meetingsOf, seedEpoch, seedListener } from './capture.ts';
import { createDatabaseOn } from './database.ts';
import { seedWorkspace } from './fixtures.ts';
import { type MemoryObjectStore, memoryObjectStore } from './object-store.ts';

/** Seconds `[0, 30)` and `[40, 60)` of audio reached storage; the meeting's speech ends at 55 s. */
const seed = (store: MemoryObjectStore) =>
  Effect.gen(function* () {
    yield* migrate(loadMigrations());
    const [owner, device] = yield* seedWorkspace('Review', ['owner', 'device']);
    const listener = yield* seedListener(device!);
    const epoch = yield* seedEpoch(listener);
    for (const sequence of [0, 1, 2, 4, 5]) yield* commitChunk(listener, epoch, sequence, store);
    const plan = yield* hear(listener, epoch, 0, 6, 'I will send the pilot plan.', { label: 'Dana' });
    yield* hear(listener, epoch, 32, 38, 'Said while the laptop slept.');
    const pilot = yield* hear(listener, epoch, 45, 55, 'Keep pilot access to the test group.', { label: 'Lee' });
    const meetings = yield* meetingsOf(listener.workspace_id);
    if (meetings.length !== 1) throw new Error(`expected one meeting, got ${meetings.length}`);
    const meeting_id = MeetingId.make(meetings[0]!.id);
    yield* closeMeeting(owner!, meeting_id);
    yield* finalizeMeeting(claimed(listener.workspace_id, 'meeting.finalize', { meeting_id }));
    yield* assembleRecording(claimed(listener.workspace_id, 'recording.assemble', { meeting_id }));
    const cite = (segment: typeof plan, start_ms: number) => [{ segment_id: segment.id, start_ms, end_ms: start_ms + 5_000 }];
    const { revision } = yield* getContextSnapshot(owner!, meeting_id);
    const decision = yield* addContextItem(owner!, {
      meeting_id, expected_revision: revision, kind: 'decision', text: 'Keep pilot access limited to the test group.', sources: cite(pilot, 45_000), idempotency_key: 'decision',
    });
    yield* addContextItem(owner!, {
      meeting_id, expected_revision: revision + 1, kind: 'commitment', text: 'Dana sends the pilot plan.', sources: cite(plan, 0), idempotency_key: 'commitment',
    });
    yield* reviseContextItem(owner!, decision.id, { expected_revision: decision.revision, idempotency_key: 'commit-decision', state: 'committed' });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO actions (id, workspace_id, meeting_id, requested_by, action_key, idempotency_key, args, args_sha256, version, state, attempts, created_at, updated_at)
      VALUES (${randomUUID()}, ${owner!.workspace_id}, ${meeting_id}, ${owner!.principal.id}, 'gmail-send-email', 'notes-email', '{}', ${randomBytes(32)}, '0.1.4', 'succeeded', 1,
        UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    // A returning person: the first-run welcome was done before, so it does not cover Review.
    yield* sql`UPDATE principals SET onboarded_at = UTC_TIMESTAMP(6) WHERE id = ${owner!.principal.id}`;
    return owner!;
  });

/** Signed object reads with byte ranges, as the browser's audio element asks for them. */
const objectServer = (store: MemoryObjectStore) =>
  createServer((request, response) => {
    const key = store.verifySignedUrl(`https://objects.test${request.url}`);
    const object = key === null ? undefined : store.objects.get(key);
    if (object === undefined) return void response.writeHead(403).end();
    const body = Buffer.from(object.body);
    const [, from, to] = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '') ?? [];
    const [start, end] = from === undefined ? [0, body.length - 1] : [Number(from), to ? Number(to) : body.length - 1];
    const range = from === undefined ? {} : { 'content-range': `bytes ${start}-${end}/${body.length}` };
    response.writeHead(from === undefined ? 200 : 206, { 'content-type': object.contentType, 'accept-ranges': 'bytes', ...range }).end(body.subarray(start, end + 1));
  });

const adminUrl = process.env['SANCTUM_TEST_MYSQL_URL'];
if (adminUrl === undefined) throw new Error('SANCTUM_TEST_MYSQL_URL must name a MySQL server that allows CREATE/DROP DATABASE');
const { mysql, drop } = await createDatabaseOn(adminUrl);
const store = memoryObjectStore();
const scope = Effect.runSync(Scope.make());
const objects = objectServer(store);
const stop = async () => {
  objects.close();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await drop();
  process.exit(0);
};
process.once('SIGTERM', () => void stop());
try {
  const db = Layer.merge(dbLayer(mysql), store.layer);
  const owner = seed(store).pipe(Effect.flatMap(({ workspace_id, principal }) => openSession({ workspace_id, principal_id: principal.id })));
  const { token: session, csrf_token: csrf } = await Effect.runPromise(Effect.provide(owner, db));
  const layer = serverLayer({ apiPort: 0, mysql }, KernelAuthenticatorLive, { media: Layer.merge(SpeechToTextLive, store.layer) });
  const address = Context.get(await Effect.runPromise(Scope.extend(Layer.build(layer), scope)), HttpServer.HttpServer).address;
  if (address._tag !== 'TcpAddress') throw new Error('expected TCP');
  await new Promise<void>(resolve => objects.listen(0, '127.0.0.1', resolve));
  const objectsPort = (objects.address() as { port: number }).port;
  console.log(JSON.stringify({ url: `http://127.0.0.1:${address.port}`, objects: `http://127.0.0.1:${objectsPort}`, session, csrf }));
} catch (error) {
  console.error(error);
  await stop();
}
