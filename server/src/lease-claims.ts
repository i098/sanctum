/**
 * Listener lease history (plan section 05 "Listener identities and ownership"). Identity is the
 * lease generation alone, so audio a device captured under generation g counts as held only until
 * a later generation was claimed; archive registration and chunk uploads check that instant.
 */
import { SqlClient } from '@effect/sql';
import type { ListenerId, WorkspaceId } from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { DbUtc } from './db.ts';

/** Records that `lease_generation` was claimed now; called in the claiming transaction. */
export const recordClaim = (workspace_id: WorkspaceId, listener_id: ListenerId, lease_generation: number) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    sql`INSERT INTO listener_lease_claims (workspace_id, listener_id, lease_generation, claimed_at)
      VALUES (${workspace_id}, ${listener_id}, ${lease_generation}, UTC_TIMESTAMP(6))`);

/**
 * Whether audio that ends at `until_ms` (Unix milliseconds on the device's clock) was captured while
 * `lease_generation` held the lease: that generation was claimed and no later one had been claimed yet.
 */
export const heldUntil = (workspace_id: WorkspaceId, listener_id: string, lease_generation: number, until_ms: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const until = Schema.encodeSync(DbUtc)(new Date(until_ms).toISOString() as typeof DbUtc.Type);
    const [row] = yield* sql<{ claimed: number | string; superseded: number | string }>`
      SELECT COUNT(CASE WHEN lease_generation = ${lease_generation} THEN 1 END) AS claimed,
             COUNT(CASE WHEN lease_generation > ${lease_generation} AND claimed_at < ${until} THEN 1 END) AS superseded
      FROM listener_lease_claims WHERE workspace_id = ${workspace_id} AND listener_id = ${listener_id}`;
    return Number(row?.claimed) > 0 && Number(row?.superseded) === 0;
  });
