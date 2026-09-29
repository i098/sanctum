/**
 * Capture-group ownership lease (plan section 05, "Listener identities and ownership").
 * Room and laptop listeners that intentionally represent the same meeting share one group;
 * exactly one member owns live writes at a time, fenced by an incrementing generation.
 * Membership is `listeners.capture_group_id` in the same workspace; a configured room
 * listener (`preferred_listener_id`) takes the lease whenever it heartbeats, and any other
 * member takes over only after the current lease expires (tab closed, sleep, partition).
 */
import { SqlClient, SqlSchema } from '@effect/sql';
import type { HeartbeatReceipt, ListenerId, WorkspaceId } from '@sanctum/contracts';
import { Effect, Option, Schema } from 'effect';
import { engineeringDefaults } from './config.ts';
import { DbSafeInt, DbUtc } from './db.ts';

type Receipt = typeof HeartbeatReceipt.Type;

const LeaseRow = Schema.Struct({
  holder: Schema.NullOr(Schema.String),
  generation: DbSafeInt,
  preferred: Schema.NullOr(Schema.String),
  expires_at: Schema.NullOr(DbUtc),
  now: DbUtc,
  renewed_until: DbUtc,
});

const LeaseRequest = Schema.Struct({ workspace_id: Schema.String, capture_group_id: Schema.String, listener_id: Schema.String });

/**
 * Renews or acquires the group lease for `listener_id` and reports whether it owns live
 * writes. The holder renews under its current generation; every change of owner (including
 * reacquiring an expired lease) gets a new generation, so writes carrying an older one are
 * rejected. A caller presenting a stale generation while the lease is live gets `owner: false`.
 * A listener outside the group gets `owner: false` without learning anything about it.
 */
export const claimGroupLease = (input: {
  readonly workspace_id: WorkspaceId;
  readonly capture_group_id: string;
  readonly listener_id: ListenerId;
  readonly lease_generation: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const findLease = SqlSchema.findOne({
      Request: LeaseRequest,
      Result: LeaseRow,
      execute: request => sql`
        SELECT g.lease_listener_id AS holder, g.lease_generation AS generation, g.preferred_listener_id AS preferred,
          g.lease_expires_at AS expires_at, UTC_TIMESTAMP(6) AS now,
          DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${engineeringDefaults.ownershipLeaseMs * 1000} MICROSECOND) AS renewed_until
        FROM capture_groups g
        JOIN listeners l ON l.workspace_id = g.workspace_id AND l.capture_group_id = g.id
        WHERE g.workspace_id = ${request.workspace_id} AND g.id = ${request.capture_group_id} AND l.id = ${request.listener_id}
        FOR UPDATE OF g`,
    });
    const claim = Effect.gen(function* () {
      const found = yield* findLease(input);
      if (Option.isNone(found)) {
        const [row] = yield* sql<{ now: string }>`SELECT UTC_TIMESTAMP(6) AS now`;
        return { lease_generation: input.lease_generation, lease_expires_at: Schema.decodeSync(DbUtc)(row!.now), owner: false } satisfies Receipt;
      }
      const lease = found.value;
      const live = lease.expires_at !== null && lease.expires_at > lease.now;
      const holds = lease.holder === input.listener_id;
      const renewal = live && holds && lease.generation === input.lease_generation;
      // A live lease is kept from other members (unless the caller is the preferred room) and from a
      // stale writer under the holder's own listener id, e.g. a second tab: it must not evict the owner.
      const blocked = live && (holds ? !renewal : lease.preferred !== input.listener_id);
      if (blocked) return { lease_generation: lease.generation, lease_expires_at: lease.expires_at!, owner: false } satisfies Receipt;
      const generation = renewal ? lease.generation : lease.generation + 1;
      yield* sql`
        UPDATE capture_groups
        SET lease_listener_id = ${input.listener_id}, lease_generation = ${generation}, lease_expires_at = ${Schema.encodeSync(DbUtc)(lease.renewed_until)}
        WHERE workspace_id = ${input.workspace_id} AND id = ${input.capture_group_id}`;
      return { lease_generation: generation, lease_expires_at: lease.renewed_until, owner: true } satisfies Receipt;
    });
    return yield* sql.withTransaction(claim).pipe(Effect.catchTag('ParseError', Effect.die));
  });
