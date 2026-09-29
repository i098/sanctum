/**
 * Listener lease history (plan section 05 "Listener identities and ownership"). Identity is the
 * lease generation alone, so audio a device captured under generation g counts as held only until
 * a later generation was claimed; archive registration and chunk uploads check that instant.
 */
import { SqlClient } from '@effect/sql';
import type { ListenerId, UtcTimestamp, WorkspaceId } from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { DbUtc } from './db.ts';

/** Records that `lease_generation` was claimed now; called in the claiming transaction. */
export const recordClaim = (workspace_id: WorkspaceId, listener_id: ListenerId, lease_generation: number) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    sql`INSERT INTO listener_lease_claims (workspace_id, listener_id, lease_generation, claimed_at)
      VALUES (${workspace_id}, ${listener_id}, ${lease_generation}, UTC_TIMESTAMP(6))`);

/**
 * Whether audio captured at `captured_at` (the device's clock) and lasting `duration_us` was recorded
 * while `lease_generation` held the lease: that generation was claimed and no later one was claimed before it ended.
 */
export const heldUntil = (workspace_id: WorkspaceId, listener_id: string, lease_generation: number, captured_at: UtcTimestamp, duration_us: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ claimed: number | string; superseded: number | string }>`
      SELECT COUNT(CASE WHEN lease_generation = ${lease_generation} THEN 1 END) AS claimed,
             COUNT(CASE WHEN lease_generation > ${lease_generation}
                         AND claimed_at < TIMESTAMPADD(MICROSECOND, ${duration_us}, ${Schema.encodeSync(DbUtc)(captured_at)}) THEN 1 END) AS superseded
      FROM listener_lease_claims WHERE workspace_id = ${workspace_id} AND listener_id = ${listener_id}`;
    return Number(row?.claimed) > 0 && Number(row?.superseded) === 0;
  });
