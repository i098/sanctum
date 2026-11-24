import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { MeetingId } from '@sanctum/contracts';
import { Effect } from 'effect';
import { hasFullText, setFullTextForTest } from '../src/db.ts';
import { closeMeeting, finalizeMeeting } from '../src/meetings.ts';
import { assembleRecording } from '../src/playback.ts';
import { workspaceIsLive } from '../src/store.ts';
import { claimed, commitChunk, hear, meetingsOf, RATE, seedEpoch, seedListener } from './support/capture.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';
import { memoryObjectStore } from './support/object-store.ts';

/** Runs `effect` and returns every `<table> <lock clause>` pair its workspace and recording reads sent to the database. */
const lockClauses = <A, E, R>(effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sent = new Set<string>();
    const spy = new Proxy(sql, {
      apply: (target, self, args) => {
        const statement = Reflect.apply(target, self, args);
        const found = /\bFROM (workspaces|meeting_recordings)\b[^;]*?\b(FOR (?:SHARE|UPDATE))\b/i.exec(statement.compile()[0]);
        if (found) sent.add(`${found[1]} ${found[2]!.toUpperCase()}`);
        return statement;
      },
    });
    yield* Effect.provideService(effect, SqlClient.SqlClient, spy);
    return sent;
  });

/** MySQL has `FOR SHARE`; TiDB rejects it, so there the same reads must take `FOR UPDATE`. */
const dialects = [
  { name: 'TiDB', fullText: false, clause: 'FOR UPDATE' },
  { name: 'MySQL', fullText: true, clause: 'FOR SHARE' },
] as const;

describe('read locks that guard workspace deletion and recording cuts', () => {
  for (const { name, fullText, clause } of dialects) {
    it.effect(`${name}: workspaceIsLive, assembleRecording and a late final lock with ${clause}`, () => {
      const store = memoryObjectStore();
      return withDatabase(
        Effect.gen(function* () {
          const original = hasFullText();
          // A real TiDB server cannot run `FOR SHARE`, so the MySQL form has nothing to run against there.
          if (fullText && !original) return;
          const sql = yield* SqlClient.SqlClient;
          yield* Effect.acquireUseRelease(
            Effect.sync(() => setFullTextForTest(fullText)),
            () =>
              Effect.gen(function* () {
                const [device] = yield* seedWorkspace('Lock dialect', ['device']);
                const listener = yield* seedListener(device!);
                const epoch = yield* seedEpoch(listener);
                for (const sequence of [0, 1, 2, 3]) yield* commitChunk(listener, epoch, sequence, store);
                yield* hear(listener, epoch, 0, 25, 'we are reviewing the launch checklist today');
                const meeting = MeetingId.make((yield* meetingsOf(listener.workspace_id))[0]!.id);
                yield* closeMeeting(device!, meeting, { epoch_id: epoch, fence_sample: 40 * RATE });
                yield* finalizeMeeting(claimed(listener.workspace_id, 'meeting.finalize', { meeting_id: meeting }));

                const noShareOnTidb = (sent: ReadonlySet<string>) => {
                  if (!fullText) expect([...sent].filter(entry => entry.endsWith('FOR SHARE'))).toEqual([]);
                };
                const live = yield* lockClauses(sql.withTransaction(workspaceIsLive(listener.workspace_id)));
                expect([...live]).toEqual([`workspaces ${clause}`]);
                noShareOnTidb(live);

                const assembled = yield* lockClauses(assembleRecording(claimed(listener.workspace_id, 'recording.assemble', { meeting_id: meeting })));
                expect(assembled).toContain(`workspaces ${clause}`);
                expect(assembled).toContain(`meeting_recordings ${clause}`);
                noShareOnTidb(assembled);
                expect(yield* sql`SELECT 1 FROM meeting_recordings WHERE meeting_id = ${meeting}`).toHaveLength(1);

                const joined = yield* lockClauses(hear(listener, epoch, 31, 34, 'and include the revised deadline'));
                expect(joined).toContain(`meeting_recordings ${clause}`);
                noShareOnTidb(joined);
                expect((yield* meetingsOf(listener.workspace_id)).map(row => row.boundary_revision)).toEqual([2]);
              }),
            () => Effect.sync(() => setFullTextForTest(original)),
          );
        }).pipe(Effect.provide(store.layer)),
        { migrated: true },
      );
    }, 60_000);
  }
});
