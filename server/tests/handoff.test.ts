import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { ListenerId, type WorkspaceId } from '@sanctum/contracts';
import { Effect } from 'effect';
import { claimGroupLease } from '../src/capture-groups.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

/** Plan section 02 default (`engineeringDefaults.ownershipLeaseMs`, asserted in api.test.ts). */
const OWNERSHIP_LEASE_MS = 45_000;

interface Room {
  readonly workspace_id: WorkspaceId;
  readonly group: string;
  readonly room: ListenerId;
  readonly laptop: ListenerId;
}

/** One workspace with a capture group holding a room and a laptop listener (optionally room-preferred). */
const seedRoom = (options: { readonly preferRoom: boolean }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [, roomDevice, laptopDevice] = yield* seedWorkspace(`Room ${randomUUID()}`, ['owner', 'device', 'device']);
    const workspace_id = roomDevice!.workspace_id;
    const group = randomUUID();
    const room = ListenerId.make(randomUUID());
    const laptop = ListenerId.make(randomUUID());
    yield* sql`INSERT INTO capture_groups (id, workspace_id, name, created_at) VALUES (${group}, ${workspace_id}, 'Board room', UTC_TIMESTAMP(6))`;
    for (const [id, principal, mode] of [[room, roomDevice!, 'room'], [laptop, laptopDevice!, 'laptop']] as const) {
      yield* sql`INSERT INTO listeners (id, workspace_id, principal_id, capture_group_id, name, mode, capabilities, created_at)
        VALUES (${id}, ${workspace_id}, ${principal.principal.id}, ${group}, ${mode}, ${mode}, '{}', UTC_TIMESTAMP(6))`;
    }
    if (options.preferRoom) yield* sql`UPDATE capture_groups SET preferred_listener_id = ${room} WHERE id = ${group}`;
    return { workspace_id, group, room, laptop } satisfies Room;
  });

const claim = (room: Room, listener_id: ListenerId, lease_generation: number) =>
  claimGroupLease({ workspace_id: room.workspace_id, capture_group_id: room.group, listener_id, lease_generation });

/** Simulates the holder going silent (tab closed, sleep, partition) for longer than the lease. */
const expireLease = (room: Room) =>
  Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE capture_groups SET lease_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ${room.group}`);

const holder = (room: Room) =>
  Effect.flatMap(SqlClient.SqlClient, sql => sql<{ holder: string | null }>`SELECT lease_listener_id AS holder FROM capture_groups WHERE id = ${room.group}`).pipe(
    Effect.map(rows => rows[0]?.holder ?? null),
  );

describe('capture-group handoff', () => {
  it.effect('grants simultaneous room and laptop heartbeats exactly one owner', () =>
    withDatabase(
      Effect.gen(function* () {
        const room = yield* seedRoom({ preferRoom: false });
        const receipts = yield* Effect.all([claim(room, room.room, 0), claim(room, room.laptop, 0)], { concurrency: 'unbounded' });
        expect(receipts.filter(receipt => receipt.owner)).toHaveLength(1);
        expect(receipts.map(receipt => receipt.lease_generation)).toEqual([1, 1]);
        const owner = receipts[0]!.owner ? room.room : room.laptop;
        expect(yield* holder(room)).toBe(owner);
      }),
      { migrated: true },
    ),
  );

  it.effect('renews the holder under one generation for the configured lease', () =>
    withDatabase(
      Effect.gen(function* () {
        const room = yield* seedRoom({ preferRoom: false });
        const first = yield* claim(room, room.room, 0);
        const renewed = yield* claim(room, room.room, first.lease_generation);
        expect(renewed).toMatchObject({ owner: true, lease_generation: 1 });
        expect(renewed.lease_expires_at >= first.lease_expires_at).toBe(true);
        const lease = Date.parse(renewed.lease_expires_at) - Date.now();
        expect(lease).toBeGreaterThan(OWNERSHIP_LEASE_MS - 5_000);
        expect(lease).toBeLessThanOrEqual(OWNERSHIP_LEASE_MS + 1_000);
      }),
      { migrated: true },
    ),
  );

  it.effect('prefers the configured room listener and fences the laptop it replaces', () =>
    withDatabase(
      Effect.gen(function* () {
        const room = yield* seedRoom({ preferRoom: true });
        const laptop = yield* claim(room, room.laptop, 0);
        expect(laptop).toMatchObject({ owner: true, lease_generation: 1 });
        const preferred = yield* claim(room, room.room, 0);
        expect(preferred).toMatchObject({ owner: true, lease_generation: 2 });
        const stale = yield* claim(room, room.laptop, laptop.lease_generation);
        expect(stale).toEqual({ owner: false, lease_generation: 2, lease_expires_at: preferred.lease_expires_at });
        expect(yield* holder(room)).toBe(room.room);
      }),
      { migrated: true },
    ),
  );

  it.effect('lets an open laptop take over only after the room lease lapses, then hands back', () =>
    withDatabase(
      Effect.gen(function* () {
        const room = yield* seedRoom({ preferRoom: true });
        const roomLease = yield* claim(room, room.room, 0);
        expect(yield* claim(room, room.laptop, 0)).toMatchObject({ owner: false, lease_generation: 1 });

        yield* expireLease(room);
        const takeover = yield* claim(room, room.laptop, 0);
        expect(takeover).toMatchObject({ owner: true, lease_generation: 2 });

        const returned = yield* claim(room, room.room, roomLease.lease_generation);
        expect(returned).toMatchObject({ owner: true, lease_generation: 3 });
        expect(yield* claim(room, room.laptop, takeover.lease_generation)).toMatchObject({ owner: false, lease_generation: 3 });
      }),
      { migrated: true },
    ),
  );

  it.effect('rejects a stale owner after a partition and a duplicate tab of the holder', () =>
    withDatabase(
      Effect.gen(function* () {
        const room = yield* seedRoom({ preferRoom: false });
        const before = yield* claim(room, room.room, 0);
        yield* expireLease(room);
        const takeover = yield* claim(room, room.laptop, 0);
        expect(takeover).toMatchObject({ owner: true, lease_generation: 2 });
        expect(yield* claim(room, room.room, before.lease_generation)).toMatchObject({ owner: false, lease_generation: 2 });

        // Same listener, older generation (a duplicate tab) cannot evict the live owner, repeatedly.
        for (let beat = 0; beat < 2; beat++) {
          expect(yield* claim(room, room.laptop, 0)).toMatchObject({ owner: false, lease_generation: 2 });
          expect(yield* claim(room, room.laptop, takeover.lease_generation)).toMatchObject({ owner: true, lease_generation: 2 });
        }
        // After the lease lapses (reloaded tab, lost heartbeat) the listener reacquires under a new generation.
        yield* expireLease(room);
        expect(yield* claim(room, room.laptop, 0)).toMatchObject({ owner: true, lease_generation: 3 });
        expect(yield* claim(room, room.laptop, takeover.lease_generation)).toMatchObject({ owner: false, lease_generation: 3 });
      }),
      { migrated: true },
    ),
  );

  it.effect('never shares a lease across groups or workspaces', () =>
    withDatabase(
      Effect.gen(function* () {
        const first = yield* seedRoom({ preferRoom: false });
        const second = yield* seedRoom({ preferRoom: false });
        const owners = yield* Effect.all([claim(first, first.room, 0), claim(second, second.room, 0)], { concurrency: 'unbounded' });
        expect(owners.map(receipt => receipt.owner)).toEqual([true, true]);

        yield* expireLease(first);
        const intruders = [
          yield* claim(first, second.laptop, 0),
          yield* claimGroupLease({ workspace_id: second.workspace_id, capture_group_id: first.group, listener_id: second.laptop, lease_generation: 0 }),
        ];
        for (const receipt of intruders) expect(receipt).toMatchObject({ owner: false, lease_generation: 0 });
        expect(yield* holder(first)).toBe(first.room);
      }),
      { migrated: true },
    ),
  );
});
