/**
 * Listener devices, ownership leases and capture epochs (plan section 05, T08).
 * A listener belongs to the principal that registered it; only that principal may heartbeat, stream
 * or upload for it. The ownership generation increments on every takeover, fencing stale tabs out of
 * live-state writes, while archive chunks from any generation stay accepted as evidence.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient, SqlSchema } from '@effect/sql';
import {
  type AccessScope,
  AcceptedMessage,
  CaptureEpochId,
  type EpochEndReason,
  Forbidden,
  type Heartbeat,
  type HeartbeatReceipt,
  type Listener,
  ListenerId,
  ListenerMode,
  ListenerState,
  MAX_FRAME_BYTES,
  NotFound,
  type RegisterListener,
  RejectedMessage,
  type StartMessage,
  WorkspaceId,
} from '@sanctum/contracts';
import { Effect, Option, Schema } from 'effect';
import { engineeringDefaults } from './config.ts';
import { DbSafeInt, DbUtc } from './db.ts';
import { onCaptureEnded } from './meetings.ts';

const ListenerRow = Schema.Struct({
  id: ListenerId,
  workspace_id: WorkspaceId,
  capture_group_id: Schema.NullOr(Schema.String),
  name: Schema.String,
  mode: ListenerMode,
  state: ListenerState,
  lease_generation: DbSafeInt,
  lease_expires_at: Schema.NullOr(DbUtc),
  current_epoch_id: Schema.NullOr(CaptureEpochId),
  last_heartbeat_at: Schema.NullOr(DbUtc),
  lease_active: DbSafeInt,
});
export type ListenerRow = typeof ListenerRow.Type;

const EpochRow = Schema.Struct({
  id: CaptureEpochId,
  listener_id: ListenerId,
  sample_rate: DbSafeInt,
  sample_start: DbSafeInt,
  live_sample_end: DbSafeInt,
  ended: DbSafeInt,
});

type StartVerdict = typeof AcceptedMessage.Type | typeof RejectedMessage.Type;

const rejected = (reason: (typeof RejectedMessage.Type)['reason'], message: string): StartVerdict => RejectedMessage.make({ reason, message });

/** The caller's own listener (optionally row-locked); other principals' and workspaces' listeners are NotFound. */
export const ownedListener = (access: AccessScope, listener_id: ListenerId, lock = false) =>
  Effect.gen(function* () {
    if (!access.scopes.includes('capture:ingest')) {
      return yield* new Forbidden({ message: 'The capture:ingest scope is required', required_scope: 'capture:ingest' });
    }
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findOne({
      Request: ListenerId,
      Result: ListenerRow,
      execute: id => sql`
        SELECT id, workspace_id, capture_group_id, name, mode, state, lease_generation, lease_expires_at, current_epoch_id,
               last_heartbeat_at, COALESCE(lease_expires_at > UTC_TIMESTAMP(6), 0) AS lease_active
        FROM listeners
        WHERE workspace_id = ${access.workspace_id} AND id = ${id} AND principal_id = ${access.principal.id}
        ${lock ? sql.unsafe('FOR UPDATE') : sql.unsafe('')}`,
    });
    const row = yield* find(listener_id).pipe(Effect.catchTag('ParseError', Effect.die));
    return Option.isSome(row) ? row.value : yield* new NotFound({ message: 'Listener not found' });
  });

/** The epoch if it exists in this workspace. */
const findEpoch = (workspace_id: WorkspaceId, epoch_id: CaptureEpochId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findOne({
      Request: CaptureEpochId,
      Result: EpochRow,
      execute: id => sql`
        SELECT id, listener_id, sample_rate, sample_start, live_sample_end, ended_at IS NOT NULL AS ended
        FROM capture_epochs WHERE workspace_id = ${workspace_id} AND id = ${id}`,
    });
    return yield* find(epoch_id).pipe(Effect.catchTag('ParseError', Effect.die));
  });

const toListener = ({ capture_group_id: _group, lease_active: _active, ...listener }: ListenerRow): Listener => listener;

export const registerListener = (access: AccessScope, input: typeof RegisterListener.Type) =>
  Effect.gen(function* () {
    if (!access.scopes.includes('capture:ingest')) {
      return yield* new Forbidden({ message: 'The capture:ingest scope is required', required_scope: 'capture:ingest' });
    }
    const sql = yield* SqlClient.SqlClient;
    const id = ListenerId.make(randomUUID());
    yield* sql`
      INSERT INTO listeners (id, workspace_id, principal_id, name, mode, capabilities, created_at)
      VALUES (${id}, ${access.workspace_id}, ${access.principal.id}, ${input.name}, ${input.mode}, ${JSON.stringify(input.capabilities)}, UTC_TIMESTAMP(6))`;
    return toListener(yield* ownedListener(access, id));
  });

/** Ends an open epoch once and tells meetings; a no-op when it already ended. */
const endEpoch = (workspace_id: WorkspaceId, listener_id: ListenerId, epoch_id: CaptureEpochId, reason: typeof EpochEndReason.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const epoch = yield* findEpoch(workspace_id, epoch_id);
    if (Option.isNone(epoch) || epoch.value.ended === 1) return;
    yield* sql`UPDATE capture_epochs SET ended_at = UTC_TIMESTAMP(6), end_reason = ${reason} WHERE workspace_id = ${workspace_id} AND id = ${epoch_id}`;
    yield* sql`UPDATE listeners SET current_epoch_id = NULL WHERE workspace_id = ${workspace_id} AND id = ${listener_id} AND current_epoch_id = ${epoch_id}`;
    yield* onCaptureEnded({ workspace_id, listener_id, epoch_id, track: 0, sample_end: epoch.value.live_sample_end, reason });
  });

/**
 * Renews the caller's lease, or takes it over when the previous owner's lease lapsed. Generation 0
 * means never claimed, so the first claim always increments. A takeover interrupts the old owner's epoch.
 * An owner in a capture group still needs the group lease (`capture_group_id` tells the caller which).
 */
export const heartbeat = (access: AccessScope, listener_id: ListenerId, input: typeof Heartbeat.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const listener = yield* ownedListener(access, listener_id, true);
        const renew = input.lease_generation === listener.lease_generation && listener.lease_generation > 0;
        if (!renew && listener.lease_active === 1) {
          const receipt: typeof HeartbeatReceipt.Type = { lease_generation: listener.lease_generation, lease_expires_at: listener.lease_expires_at!, owner: false };
          return { ...receipt, capture_group_id: null };
        }
        if (!renew && listener.current_epoch_id !== null) yield* endEpoch(access.workspace_id, listener_id, listener.current_epoch_id, 'interrupted');
        const generation = renew ? listener.lease_generation : listener.lease_generation + 1;
        const health = JSON.stringify({ buffered_chunks: input.buffered_chunks, storage_bytes_free: input.storage_bytes_free, epoch_id: input.epoch_id });
        yield* sql`
          UPDATE listeners
          SET lease_generation = ${generation}, lease_expires_at = UTC_TIMESTAMP(6) + INTERVAL ${engineeringDefaults.ownershipLeaseMs * 1000} MICROSECOND,
              state = ${input.state}, health = ${health}, last_heartbeat_at = UTC_TIMESTAMP(6)
          WHERE workspace_id = ${access.workspace_id} AND id = ${listener_id}`;
        const renewed = yield* ownedListener(access, listener_id);
        const receipt: typeof HeartbeatReceipt.Type = { lease_generation: generation, lease_expires_at: renewed.lease_expires_at!, owner: true };
        return { ...receipt, capture_group_id: renewed.capture_group_id };
      }),
    );
  });

/**
 * Validates a live `start` against the lease and epoch. An existing open epoch resumes at its live
 * watermark (reconnect); a new epoch ends the listener's previous one and records its clock anchor.
 * An `archive_only` start passes the same checks but only records its epoch, already ended, for uploads.
 */
export const startEpoch = (access: AccessScope, start: typeof StartMessage.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const listener = yield* ownedListener(access, start.listener_id, true);
        if (listener.lease_active !== 1 || listener.lease_generation !== start.lease_generation) {
          return rejected('stale_generation', `Ownership generation ${start.lease_generation} is not the current lease`);
        }
        const accepted = (resume_from_sample: number) => AcceptedMessage.make({ epoch_id: start.epoch_id, resume_from_sample, max_frame_bytes: MAX_FRAME_BYTES });
        const existing = yield* findEpoch(access.workspace_id, start.epoch_id);
        if (Option.isSome(existing)) {
          const epoch = existing.value;
          if (epoch.listener_id !== listener.id || epoch.sample_rate !== start.clock.sample_rate) return rejected('invalid_start', 'The epoch belongs to another listener or clock');
          return epoch.ended === 1 && !start.archive_only ? rejected('epoch_closed', 'The epoch ended; start a new one') : accepted(epoch.live_sample_end);
        }
        if (listener.current_epoch_id !== null && !start.archive_only) {
          yield* endEpoch(access.workspace_id, listener.id, listener.current_epoch_id, start.start_reason === 'device_change' ? 'device_change' : 'interrupted');
        }
        const { clock } = start;
        yield* sql`
          INSERT INTO capture_epochs (id, workspace_id, listener_id, lease_generation, sample_rate, channels, encoding, sample_start, captured_at,
                                      timezone, start_reason, started_at, live_sample_end, ended_at, end_reason)
          VALUES (${start.epoch_id}, ${access.workspace_id}, ${listener.id}, ${start.lease_generation}, ${clock.sample_rate}, ${clock.channels},
                  ${clock.encoding}, ${clock.sample_start}, ${Schema.encodeSync(DbUtc)(clock.captured_at)}, ${clock.timezone}, ${start.start_reason}, UTC_TIMESTAMP(6),
                  ${clock.sample_start}, IF(${start.archive_only === true}, UTC_TIMESTAMP(6), NULL), ${start.archive_only ? 'interrupted' : null})`;
        if (start.archive_only) return accepted(clock.sample_start);
        yield* sql`UPDATE listeners SET current_epoch_id = ${start.epoch_id}, state = 'listening' WHERE workspace_id = ${access.workspace_id} AND id = ${listener.id}`;
        return accepted(clock.sample_start);
      }),
    );
  });

/**
 * Persists the live watermark while `lease_generation` still owns the listener; `false` means a
 * newer owner took over and the caller must stop live writes.
 */
export const advanceLiveWatermark = (access: AccessScope, listener_id: ListenerId, epoch_id: CaptureEpochId, lease_generation: number, sample_end: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const listener = yield* ownedListener(access, listener_id, true);
        if (listener.lease_generation !== lease_generation) return false;
        yield* sql`
          UPDATE capture_epochs SET live_sample_end = GREATEST(live_sample_end, ${sample_end})
          WHERE workspace_id = ${access.workspace_id} AND id = ${epoch_id} AND ended_at IS NULL`;
        return true;
      }),
    );
  });

/** Client `stop`: ends the epoch (pause, close or device change) unless a newer owner already took over. */
export const stopEpoch = (access: AccessScope, listener_id: ListenerId, epoch_id: CaptureEpochId, lease_generation: number, reason: 'pause' | 'close' | 'device_change') =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const listener = yield* ownedListener(access, listener_id, true);
        if (listener.lease_generation !== lease_generation) return;
        yield* endEpoch(access.workspace_id, listener_id, epoch_id, reason);
        yield* sql`UPDATE listeners SET state = ${reason === 'pause' ? 'paused' : 'stopped'} WHERE workspace_id = ${access.workspace_id} AND id = ${listener_id}`;
      }),
    );
  });
