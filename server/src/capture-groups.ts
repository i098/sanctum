/**
 * Capture-group ownership lease (plan section 05, "Listener identities and ownership").
 * Room and laptop listeners that intentionally represent the same meeting share one group;
 * exactly one member owns live writes at a time, fenced by an incrementing generation.
 * Membership is `listeners.capture_group_id` in the same workspace; a configured room
 * listener (`preferred_listener_id`) takes the lease whenever it heartbeats, and any other
 * member takes over only after the current lease expires (tab closed, sleep, partition).
 */
import { SqlClient, SqlSchema } from '@effect/sql';
import type { ListenerId, UtcTimestamp, WorkspaceId } from '@sanctum/contracts';
import { Effect, Option, Schema } from 'effect';
import { engineeringDefaults } from './config.ts';
import { DbSafeInt, DbUtc } from './db.ts';
import { addSeconds, now } from './sql-dialect.ts';

const LeaseRow = Schema.Struct({
  holder: Schema.NullOr(Schema.String),
  generation: DbSafeInt,
  preferred: Schema.NullOr(Schema.String),
  expires_at: Schema.NullOr(DbUtc),
  now: DbUtc,
  renewed_until: DbUtc,
});

const LeaseRequest = Schema.Struct({ workspace_id: Schema.String, capture_group_id: Schema.String, listener_id: Schema.String });

type GroupLeaseInput = { readonly workspace_id: WorkspaceId; readonly capture_group_id: string; readonly listener_id: ListenerId };

/** What a successful claim writes: the lease generation and its new expiry. */
export interface GroupLeaseGrant {
  readonly generation: number;
  readonly renewed_until: UtcTimestamp;
}

/**
 * Reads whether `listener_id` may take or renew the group lease now, and what the claim would write; null when it may not.
 * A transaction cannot read after it buffered a write, so a caller with other writes plans first and applies last.
 */
export const planGroupLease = (input: GroupLeaseInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const findLease = SqlSchema.findOne({
      Request: LeaseRequest,
      Result: LeaseRow,
      execute: request => sql`
        SELECT g.lease_listener_id AS holder, g.lease_generation AS generation, g.preferred_listener_id AS preferred,
          g.lease_expires_at AS expires_at, ${now} AS now,
          ${addSeconds(now, engineeringDefaults.ownershipLeaseMs / 1000)} AS renewed_until
        FROM capture_groups g
        JOIN listeners l ON l.workspace_id = g.workspace_id AND l.capture_group_id = g.id
        WHERE g.workspace_id = ${request.workspace_id} AND g.id = ${request.capture_group_id} AND l.id = ${request.listener_id}`,
    });
    const found = yield* findLease(input).pipe(Effect.catchTag('ParseError', Effect.die));
    if (Option.isNone(found)) return null;
    const lease = found.value;
    const live = lease.expires_at !== null && lease.expires_at > lease.now;
    const renewal = live && lease.holder === input.listener_id;
    // A live lease is kept from other members unless the caller is the preferred room.
    if (live && !renewal && lease.preferred !== input.listener_id) return null;
    return { generation: renewal ? lease.generation : lease.generation + 1, renewed_until: lease.renewed_until } satisfies GroupLeaseGrant;
  });

/** Writes a grant from `planGroupLease`. */
export const applyGroupLease = (input: GroupLeaseInput, grant: GroupLeaseGrant) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    sql => sql`
      UPDATE capture_groups
      SET lease_listener_id = ${input.listener_id}, lease_generation = ${grant.generation}, lease_expires_at = ${Schema.encodeSync(DbUtc)(grant.renewed_until)}
      WHERE workspace_id = ${input.workspace_id} AND id = ${input.capture_group_id}`,
  );

/**
 * Renews or acquires the group lease for `listener_id` and reports whether it owns live writes.
 * The caller already holds its own listener lease, which fences duplicate tabs of one listener, so
 * the holder renews under the group's current generation; every change of owner (including
 * reacquiring an expired lease) increments it. A listener outside the group never owns it.
 */
export const claimGroupLease = (input: GroupLeaseInput) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        const grant = yield* planGroupLease(input);
        if (grant === null) return false;
        yield* applyGroupLease(input, grant);
        return true;
      }),
    ),
  );

/** Whether the listener may write live: it is in no capture group, or it holds its group's unexpired lease. */
export const holdsGroupLease = (workspace_id: WorkspaceId, listener: { readonly id: ListenerId; readonly capture_group_id: string | null }) =>
  Effect.gen(function* () {
    if (listener.capture_group_id === null) return true;
    const sql = yield* SqlClient.SqlClient;
    const held = yield* sql`
      SELECT 1 FROM capture_groups
      WHERE workspace_id = ${workspace_id} AND id = ${listener.capture_group_id} AND lease_listener_id = ${listener.id} AND lease_expires_at > ${now}`;
    return held.length > 0;
  });
