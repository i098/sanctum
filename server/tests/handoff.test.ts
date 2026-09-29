import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, ListenerId, type WorkspaceId } from '@sanctum/contracts';
import { Effect } from 'effect';
import { claimGroupLease } from '../src/capture-groups.ts';
import { advanceLiveWatermark, heartbeat, startEpoch } from '../src/listeners.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';
import { newEpochId } from './support/media.ts';

/** Plan section 02 default (`engineeringDefaults.ownershipLeaseMs`, asserted in api.test.ts). */
const OWNERSHIP_LEASE_MS = 45_000;

interface Device {
  readonly id: ListenerId;
  readonly access: AccessScope;
}

interface Room {
  readonly workspace_id: WorkspaceId;
  readonly group: string;
  readonly room: Device;
  readonly laptop: Device;
}

/** One workspace with a capture group holding a room and a laptop listener (optionally room-preferred). */
const seedRoom = (options: { readonly preferRoom: boolean }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [, roomDevice, laptopDevice] = yield* seedWorkspace(`Room ${randomUUID()}`, ['owner', 'device', 'device']);
    const workspace_id = roomDevice!.workspace_id;
    const group = randomUUID();
    const room = { id: ListenerId.make(randomUUID()), access: { ...roomDevice!, scopes: ['capture:ingest'] } } satisfies Device;
    const laptop = { id: ListenerId.make(randomUUID()), access: { ...laptopDevice!, scopes: ['capture:ingest'] } } satisfies Device;
    yield* sql`INSERT INTO capture_groups (id, workspace_id, name, created_at) VALUES (${group}, ${workspace_id}, 'Board room', UTC_TIMESTAMP(6))`;
    for (const [device, mode] of [[room, 'room'], [laptop, 'laptop']] as const) {
      yield* sql`INSERT INTO listeners (id, workspace_id, principal_id, capture_group_id, name, mode, capabilities, created_at)
        VALUES (${device.id}, ${workspace_id}, ${device.access.principal.id}, ${group}, ${mode}, ${mode}, '{}', UTC_TIMESTAMP(6))`;
    }
    if (options.preferRoom) yield* sql`UPDATE capture_groups SET preferred_listener_id = ${room.id} WHERE id = ${group}`;
    return { workspace_id, group, room, laptop } satisfies Room;
  });

const beat = (device: Device, lease_generation: number) =>
  heartbeat(device.access, device.id, { lease_generation, state: 'listening', epoch_id: null, buffered_chunks: 0, storage_bytes_free: null });

const liveStart = (device: Device, lease_generation: number, epoch_id = newEpochId()) =>
  startEpoch(device.access, {
    _tag: 'start',
    protocol_version: 1,
    listener_id: device.id,
    epoch_id,
    track: 0,
    clock: { sample_rate: 16_000, channels: 1, encoding: 'pcm_s16le', sample_start: 0, captured_at: '2026-09-26T17:00:00Z', timezone: 'America/Los_Angeles' } as never,
    lease_generation,
    start_reason: 'start',
  });

/** Simulates the group holder going silent (tab closed, sleep, partition) for longer than the lease. */
const expireGroup = (room: Room) =>
  Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE capture_groups SET lease_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ${room.group}`);

const expireListener = (device: Device) =>
  Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE listeners SET lease_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ${device.id}`);

const lease = (room: Room) =>
  Effect.flatMap(SqlClient.SqlClient, sql => sql<{ holder: string | null; generation: number }>`SELECT lease_listener_id AS holder, lease_generation AS generation FROM capture_groups WHERE id = ${room.group}`).pipe(
    Effect.map(rows => ({ holder: rows[0]?.holder ?? null, generation: Number(rows[0]?.generation) })),
  );

const epochEnds = (device: Device) =>
  Effect.flatMap(SqlClient.SqlClient, sql => sql<{ end_reason: string | null }>`SELECT end_reason FROM capture_epochs WHERE listener_id = ${device.id}`).pipe(
    Effect.map(rows => rows.map(row => row.end_reason)),
  );

describe('capture-group handoff', () => {
  it.effect('grants simultaneous room and laptop heartbeats exactly one owner', () =>
    withDatabase(
      Effect.gen(function* () {
        const room = yield* seedRoom({ preferRoom: false });
        const receipts = yield* Effect.all([beat(room.room, 0), beat(room.laptop, 0)], { concurrency: 'unbounded' });
        expect(receipts.filter(receipt => receipt.owner)).toHaveLength(1);
        expect(receipts.map(receipt => receipt.lease_generation)).toEqual([1, 1]);
        const owner = receipts[0]!.owner ? room.room : room.laptop;
        expect((yield* lease(room)).holder).toBe(owner.id);
      }),
      { migrated: true },
    ),
  );

  it.effect('renews the holder under one generation for the configured lease', () =>
    withDatabase(
      Effect.gen(function* () {
        const room = yield* seedRoom({ preferRoom: false });
        const first = yield* beat(room.room, 0);
        const renewed = yield* beat(room.room, first.lease_generation);
        expect(renewed).toMatchObject({ owner: true, lease_generation: 1 });
        expect(yield* lease(room)).toEqual({ holder: room.room.id, generation: 1 });
        const expires = Date.parse(renewed.lease_expires_at) - Date.now();
        expect(expires).toBeGreaterThan(OWNERSHIP_LEASE_MS - 5_000);
        expect(expires).toBeLessThanOrEqual(OWNERSHIP_LEASE_MS + 1_000);
      }),
      { migrated: true },
    ),
  );

  it.effect('hands a device its own listener generation when the group generation differs', () =>
    withDatabase(
      Effect.gen(function* () {
        const room = yield* seedRoom({ preferRoom: false });
        const roomLease = yield* beat(room.room, 0);
        yield* expireGroup(room);
        yield* beat(room.room, roomLease.lease_generation);
        yield* expireGroup(room);
        // The group moved twice (generation 3) while the laptop has claimed its own listener once.
        const takeover = yield* beat(room.laptop, 0);
        expect(takeover).toMatchObject({ owner: true, lease_generation: 1 });
        expect(yield* lease(room)).toEqual({ holder: room.laptop.id, generation: 3 });
        for (let tick = 0; tick < 2; tick++) expect(yield* beat(room.laptop, takeover.lease_generation)).toMatchObject({ owner: true, lease_generation: 1 });
        expect(yield* liveStart(room.laptop, takeover.lease_generation)).toMatchObject({ _tag: 'accepted' });
        expect(yield* beat(room.laptop, takeover.lease_generation)).toMatchObject({ owner: true, lease_generation: 1 });
        expect(yield* epochEnds(room.laptop)).toEqual([null]);
      }),
      { migrated: true },
    ));

  it.effect('prefers the configured room listener and fences the laptop it replaces', () =>
    withDatabase(
      Effect.gen(function* () {
        const room = yield* seedRoom({ preferRoom: true });
        const laptop = yield* beat(room.laptop, 0);
        expect(laptop).toMatchObject({ owner: true, lease_generation: 1 });
        const epoch_id = newEpochId();
        expect(yield* liveStart(room.laptop, laptop.lease_generation, epoch_id)).toMatchObject({ _tag: 'accepted' });

        expect(yield* beat(room.room, 0)).toMatchObject({ owner: true, lease_generation: 1 });
        expect(yield* lease(room)).toEqual({ holder: room.room.id, generation: 2 });
        // The laptop keeps its own listener lease but loses live writes.
        expect(yield* beat(room.laptop, laptop.lease_generation)).toMatchObject({ owner: false, lease_generation: 1 });
        expect(yield* advanceLiveWatermark(room.laptop.access, room.laptop.id, epoch_id, laptop.lease_generation, 16_000)).toBe(false);
        expect(yield* liveStart(room.laptop, laptop.lease_generation)).toMatchObject({ _tag: 'rejected', reason: 'stale_generation' });
      }),
      { migrated: true },
    ),
  );

  it.effect('lets an open laptop take over only after the room lease lapses, then hands back', () =>
    withDatabase(
      Effect.gen(function* () {
        const room = yield* seedRoom({ preferRoom: true });
        const roomLease = yield* beat(room.room, 0);
        const laptop = yield* beat(room.laptop, 0);
        expect(laptop).toMatchObject({ owner: false, lease_generation: 1 });

        yield* expireGroup(room);
        expect(yield* beat(room.laptop, laptop.lease_generation)).toMatchObject({ owner: true, lease_generation: 1 });
        expect(yield* lease(room)).toEqual({ holder: room.laptop.id, generation: 2 });

        expect(yield* beat(room.room, roomLease.lease_generation)).toMatchObject({ owner: true, lease_generation: 1 });
        expect(yield* lease(room)).toEqual({ holder: room.room.id, generation: 3 });
        expect(yield* beat(room.laptop, laptop.lease_generation)).toMatchObject({ owner: false, lease_generation: 1 });
      }),
      { migrated: true },
    ),
  );

  it.effect('rejects a duplicate tab of the holder, and reacquires under a new generation after the lease lapses', () =>
    withDatabase(
      Effect.gen(function* () {
        const room = yield* seedRoom({ preferRoom: false });
        const holder = yield* beat(room.laptop, 0);
        expect(holder).toMatchObject({ owner: true, lease_generation: 1 });
        for (let tick = 0; tick < 2; tick++) {
          expect(yield* beat(room.laptop, 0)).toMatchObject({ owner: false, lease_generation: 0 });
          expect(yield* beat(room.laptop, holder.lease_generation)).toMatchObject({ owner: true, lease_generation: 1 });
        }
        expect(yield* liveStart(room.laptop, 0)).toMatchObject({ _tag: 'rejected', reason: 'stale_generation' });

        // A reloaded tab after both leases lapsed claims the listener and the group again.
        yield* expireListener(room.laptop);
        yield* expireGroup(room);
        expect(yield* beat(room.laptop, 0)).toMatchObject({ owner: true, lease_generation: 2 });
        expect(yield* lease(room)).toEqual({ holder: room.laptop.id, generation: 2 });
        expect(yield* beat(room.laptop, holder.lease_generation)).toMatchObject({ owner: false, lease_generation: 1 });
      }),
      { migrated: true },
    ),
  );

  it.effect('never shares a lease across groups or workspaces', () =>
    withDatabase(
      Effect.gen(function* () {
        const first = yield* seedRoom({ preferRoom: false });
        const second = yield* seedRoom({ preferRoom: false });
        const owners = yield* Effect.all([beat(first.room, 0), beat(second.room, 0)], { concurrency: 'unbounded' });
        expect(owners.map(receipt => receipt.owner)).toEqual([true, true]);

        yield* expireGroup(first);
        const intruders = [
          yield* claimGroupLease({ workspace_id: first.workspace_id, capture_group_id: first.group, listener_id: second.laptop.id }),
          yield* claimGroupLease({ workspace_id: second.workspace_id, capture_group_id: first.group, listener_id: second.laptop.id }),
        ];
        expect(intruders).toEqual([false, false]);
        expect((yield* lease(first)).holder).toBe(first.room.id);
      }),
      { migrated: true },
    ),
  );
});
