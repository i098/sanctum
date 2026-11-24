import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { shareLock } from '../src/db.ts';
import { workspaceIsLive } from '../src/store.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

describe('read locks on the test database', () => {
  it.effect('runs the workspace and recording lock queries with the active dialect lock', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [owner] = yield* seedWorkspace('Lock check');
        const workspace_id = owner!.workspace_id;
        expect(yield* sql.withTransaction(workspaceIsLive(workspace_id))).toBe(true);
        const rows = yield* sql.withTransaction(sql`SELECT 1 FROM meeting_recordings WHERE meeting_id = 'none' LIMIT 1 ${sql.literal(shareLock())}`);
        expect(rows).toEqual([]);
        yield* sql`UPDATE workspaces SET deleted_at = UTC_TIMESTAMP(6) WHERE id = ${workspace_id}`;
        expect(yield* sql.withTransaction(workspaceIsLive(workspace_id))).toBe(false);
      }),
      { migrated: true },
    ),
    60_000,
  );

  it.effect('accepts FOR UPDATE, the TiDB lock, on the workspace and recording lock queries', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [owner] = yield* seedWorkspace('Update lock check');
        const workspace_id = owner!.workspace_id;
        const lock = sql.literal('FOR UPDATE');
        const live = yield* sql.withTransaction(sql`SELECT 1 FROM workspaces WHERE id = ${workspace_id} AND deleted_at IS NULL ${lock}`);
        expect(live).toHaveLength(1);
        const rows = yield* sql.withTransaction(sql`SELECT 1 FROM meeting_recordings WHERE meeting_id = 'none' LIMIT 1 ${lock}`);
        expect(rows).toEqual([]);
      }),
      { migrated: true },
    ),
    60_000,
  );
});
