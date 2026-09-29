// stand-in: replaced by the serve slice at integration
/** Capture-group lease (T25). The stand-in never claims: it reports the lease exactly as stored. */
import { SqlClient, SqlSchema, type SqlError } from '@effect/sql';
import type { HeartbeatReceipt, ListenerId, WorkspaceId } from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { DbSafeInt, DbUtc } from './db.ts';

const GroupLease = Schema.Struct({ owner: DbSafeInt, lease_generation: DbSafeInt, lease_expires_at: DbUtc });

export const claimGroupLease = (input: {
  readonly workspace_id: WorkspaceId;
  readonly capture_group_id: string;
  readonly listener_id: ListenerId;
  readonly lease_generation: number;
}): Effect.Effect<typeof HeartbeatReceipt.Type, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lease = SqlSchema.single({
      Request: Schema.Void,
      Result: GroupLease,
      execute: () => sql`
        SELECT COALESCE(lease_listener_id = ${input.listener_id} AND lease_generation = ${input.lease_generation}
                        AND lease_expires_at > UTC_TIMESTAMP(6), 0) AS owner,
               lease_generation, COALESCE(lease_expires_at, UTC_TIMESTAMP(6)) AS lease_expires_at
        FROM capture_groups WHERE workspace_id = ${input.workspace_id} AND id = ${input.capture_group_id}`,
    });
    const row = yield* lease(undefined).pipe(Effect.catchTags({ ParseError: Effect.die, NoSuchElementException: Effect.die }));
    return { owner: row.owner === 1, lease_generation: row.lease_generation, lease_expires_at: row.lease_expires_at };
  });
