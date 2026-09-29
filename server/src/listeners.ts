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
import { claimGroupLease, holdsGroupLease } from './capture-groups.ts';
import { engineeringDefaults } from './config.ts';
import { DbSafeInt, DbUtc } from './db.ts';
import { heldUntil, recordClaim } from './lease-claims.ts';
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
 * means never claimed, so the first claim always increments. A lapsed lease, renewed or taken over,
 * interrupts its open epoch; the returning owner starts a new one.
 * An owner in a capture group also needs the group lease; without it `owner` is false while the
 * receipt still carries this listener's generation.
 */
export const heartbeat = (access: AccessScope, listener_id: ListenerId, input: typeof Heartbeat.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const listener = yield* ownedListener(access, listener_id, true);
        const renew = input.lease_generation === listener.lease_generation && listener.lease_generation > 0;
        if (!renew && listener.lease_active === 1) {
          // The caller keeps its own generation: handing it the holder's would let it act as the holder.
          return { lease_generation: input.lease_generation, lease_expires_at: listener.lease_expires_at!, owner: false } satisfies typeof HeartbeatReceipt.Type;
        }
        if (listener.lease_active !== 1 && listener.current_epoch_id !== null) yield* endEpoch(access.workspace_id, listener_id, listener.current_epoch_id, 'interrupted');
        const generation = renew ? listener.lease_generation : listener.lease_generation + 1;
        const health = JSON.stringify({ buffered_chunks: input.buffered_chunks, storage_bytes_free: input.storage_bytes_free, epoch_id: input.epoch_id });
        yield* sql`
          UPDATE listeners
          SET lease_generation = ${generation}, lease_expires_at = UTC_TIMESTAMP(6) + INTERVAL ${engineeringDefaults.ownershipLeaseMs * 1000} MICROSECOND,
              state = ${input.state}, health = ${health}, last_heartbeat_at = UTC_TIMESTAMP(6)
          WHERE workspace_id = ${access.workspace_id} AND id = ${listener_id}`;
        if (!renew) yield* recordClaim(access.workspace_id, listener_id, generation);
        const renewed = yield* ownedListener(access, listener_id);
        const { capture_group_id } = renewed;
        const owner = capture_group_id === null || (yield* claimGroupLease({ workspace_id: access.workspace_id, capture_group_id, listener_id }));
        return { lease_generation: generation, lease_expires_at: renewed.lease_expires_at!, owner } satisfies typeof HeartbeatReceipt.Type;
      }),
    );
  });

/**
 * Worker sweep: a listener whose lease lapsed with an epoch still open disconnected without a `stop`
 * (browser killed, power or network lost), so that epoch ends as interrupted and its meeting seals.
 */
export const sweepLapsedListeners = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lapsed = sql`current_epoch_id IS NOT NULL AND COALESCE(lease_expires_at > UTC_TIMESTAMP(6), 0) = 0`;
  const listeners = yield* sql<{ workspace_id: WorkspaceId; id: ListenerId }>`SELECT workspace_id, id FROM listeners WHERE ${lapsed}`;
  for (const { workspace_id, id } of listeners) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [open] = yield* sql<{ epoch_id: CaptureEpochId }>`SELECT current_epoch_id AS epoch_id FROM listeners
          WHERE workspace_id = ${workspace_id} AND id = ${id} AND ${lapsed} FOR UPDATE`;
        if (open === undefined) return;
        yield* endEpoch(workspace_id, id, open.epoch_id, 'interrupted');
        yield* sql`UPDATE listeners SET state = 'stopped' WHERE workspace_id = ${workspace_id} AND id = ${id}`;
      }),
    );
  }
});

const acceptedAt = (start: typeof StartMessage.Type, resume_from_sample: number): StartVerdict =>
  AcceptedMessage.make({ epoch_id: start.epoch_id, resume_from_sample, max_frame_bytes: MAX_FRAME_BYTES });

/** Records the epoch's clock anchor; `ended` inserts it already ended with that reason (archive only). */
const insertEpoch = (access: AccessScope, start: typeof StartMessage.Type, ended: typeof EpochEndReason.Type | null) =>
  Effect.flatMap(SqlClient.SqlClient, sql => {
    const { clock } = start;
    return sql`
      INSERT INTO capture_epochs (id, workspace_id, listener_id, lease_generation, sample_rate, channels, encoding, sample_start, captured_at,
                                  timezone, start_reason, started_at, live_sample_end, ended_at, end_reason, archive_sample_end)
      VALUES (${start.epoch_id}, ${access.workspace_id}, ${start.listener_id}, ${start.lease_generation}, ${clock.sample_rate}, ${clock.channels},
              ${clock.encoding}, ${clock.sample_start}, ${Schema.encodeSync(DbUtc)(clock.captured_at)}, ${clock.timezone}, ${start.start_reason}, UTC_TIMESTAMP(6),
              ${clock.sample_start}, IF(${ended !== null}, UTC_TIMESTAMP(6), NULL), ${ended}, ${ended === null ? null : (start.sample_end ?? null)})`;
  });

/** An existing epoch must belong to this listener and clock. */
const sameEpoch = (listener: ListenerRow, start: typeof StartMessage.Type, epoch: typeof EpochRow.Type) =>
  epoch.listener_id === listener.id && epoch.sample_rate === start.clock.sample_rate;

/**
 * Registers an epoch whose live `start` never reached the server, only so its chunks upload. It is
 * accepted under the generation the device held when the epoch began, even after that lease lapsed or
 * a later generation took over, and recorded already ended with the device's journaled end reason.
 */
const registerArchive = (access: AccessScope, listener: ListenerRow, start: typeof StartMessage.Type) =>
  Effect.gen(function* () {
    if (!(yield* heldUntil(access.workspace_id, listener.id, start.lease_generation, start.clock.captured_at, 0))) {
      return rejected('stale_generation', `Generation ${start.lease_generation} did not hold this listener when the epoch began`);
    }
    const existing = yield* findEpoch(access.workspace_id, start.epoch_id);
    if (Option.isSome(existing) && !sameEpoch(listener, start, existing.value)) return rejected('invalid_start', 'The epoch belongs to another listener or clock');
    if (Option.isNone(existing)) yield* insertEpoch(access, start, start.end_reason ?? 'interrupted');
    return acceptedAt(start, start.clock.sample_start);
  });

/** A live `start` under the current lease: resume an open epoch at its watermark, or end the previous one and begin this one. */
const startLive = (access: AccessScope, listener: ListenerRow, start: typeof StartMessage.Type) =>
  Effect.gen(function* () {
    const existing = yield* findEpoch(access.workspace_id, start.epoch_id);
    if (Option.isSome(existing)) {
      if (!sameEpoch(listener, start, existing.value)) return rejected('invalid_start', 'The epoch belongs to another listener or clock');
      return existing.value.ended === 1 ? rejected('epoch_closed', 'The epoch ended; start a new one') : acceptedAt(start, existing.value.live_sample_end);
    }
    if (listener.current_epoch_id !== null) {
      yield* endEpoch(access.workspace_id, listener.id, listener.current_epoch_id, start.start_reason === 'device_change' ? 'device_change' : 'interrupted');
    }
    yield* insertEpoch(access, start, null);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE listeners SET current_epoch_id = ${start.epoch_id}, state = 'listening' WHERE workspace_id = ${access.workspace_id} AND id = ${listener.id}`;
    return acceptedAt(start, start.clock.sample_start);
  });

/**
 * Validates a `start` against the lease and epoch. A live start needs the current generation and an
 * active lease; an `archive_only` start is judged by the generation held when its epoch began.
 */
export const startEpoch = (access: AccessScope, start: typeof StartMessage.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const listener = yield* ownedListener(access, start.listener_id, true);
        if (start.archive_only) return yield* registerArchive(access, listener, start);
        if (listener.lease_active !== 1 || listener.lease_generation !== start.lease_generation || !(yield* holdsGroupLease(access.workspace_id, listener))) {
          return rejected('stale_generation', `Ownership generation ${start.lease_generation} is not the current lease`);
        }
        return yield* startLive(access, listener, start);
      }),
    );
  });

/**
 * Persists the live watermark while `lease_generation` still owns the listener and the epoch is still
 * its open one; `false` means a newer owner took over or the epoch ended, and the caller must stop live writes.
 */
export const advanceLiveWatermark = (access: AccessScope, listener_id: ListenerId, epoch_id: CaptureEpochId, lease_generation: number, sample_end: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const listener = yield* ownedListener(access, listener_id, true);
        if (listener.lease_generation !== lease_generation || listener.current_epoch_id !== epoch_id || !(yield* holdsGroupLease(access.workspace_id, listener))) return false;
        yield* sql`
          UPDATE capture_epochs SET live_sample_end = GREATEST(live_sample_end, ${sample_end})
          WHERE workspace_id = ${access.workspace_id} AND id = ${epoch_id} AND ended_at IS NULL`;
        return true;
      }),
    );
  });

/** Client `stop`: ends the epoch (pause, close, device change or interruption) unless a newer owner already took over. */
export const stopEpoch = (access: AccessScope, listener_id: ListenerId, epoch_id: CaptureEpochId, lease_generation: number, reason: 'pause' | 'close' | 'device_change' | 'interrupted') =>
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
