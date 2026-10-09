import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { expect, layer } from '@effect/vitest';
import { type AccessScope, TranscriptSegmentId, type WorkspaceId } from '@sanctum/contracts';
import { Effect, Option } from 'effect';
import { createAgent } from '../src/agents.ts';
import { openSession } from '../src/auth.ts';
import { addContextItem, reviseContextItem } from '../src/context.ts';
import { claimJob, completeJob, type Lease, sweepJobs } from '../src/job-runner.ts';
import { enqueueJob } from '../src/jobs.ts';
import { addMember } from '../src/store.ts';
import { PURGED_TABLES, purgeWorkspace } from '../src/workspaces.ts';
import { migratedDatabase, seedMeeting, seedSegment } from './support/context.ts';
import { seedWorkspace } from './support/fixtures.ts';
import { type MemoryObjectStore, memoryObjectStore } from './support/object-store.ts';

const researcher = { display_name: 'Researcher', scopes: ['context:read'], meetings: { kind: 'accessible' }, expires_at: null } as const;

/** A workspace with members, a linked identity, a session, an agent, a meeting with memory, and recording objects under both purge prefixes. */
const seed = (name: string, store: MemoryObjectStore) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [owner, member, device] = yield* seedWorkspace(name, ['owner', 'member', 'device']);
    const workspace_id = owner!.workspace_id;
    yield* sql`INSERT INTO principal_identities (issuer, subject, principal_id, verified_at) VALUES ('https://issuer.test', ${randomUUID()}, ${owner!.principal.id}, UTC_TIMESTAMP(6))`;
    yield* openSession({ workspace_id, principal_id: member!.principal.id });
    yield* createAgent(owner!, researcher);
    const meeting = yield* seedMeeting(device!, { started_at: '2026-10-01 17:00:00' });
    const segment = yield* seedSegment(meeting, 1, 2, 'We ship the pilot.');
    const item = yield* addContextItem(owner!, {
      meeting_id: meeting.meeting_id,
      expected_revision: 0,
      kind: 'decision',
      text: 'Ship the pilot',
      sources: [{ segment_id: TranscriptSegmentId.make(segment), start_ms: 0, end_ms: 0 }],
      idempotency_key: `${name}-1`,
    });
    yield* reviseContextItem(owner!, item.id, { expected_revision: 1, idempotency_key: `${name}-2`, text: 'Ship the pilot Friday' });
    const keys = [
      ...Array.from({ length: 5 }, (_, i) => `workspaces/${workspace_id}/epochs/${meeting.epoch_id}/tracks/0/${i}-${randomUUID()}.wav`),
      `meetings/${workspace_id}/${meeting.meeting_id}/r1.wav`,
    ];
    for (const key of keys) store.objects.set(key, { body: new Uint8Array([1]), sha256: '00'.repeat(32), contentType: 'audio/wav' });
    return { owner: owner!, workspace_id, keys };
  });

/** Marks the workspace deleted with its grace period already over and queues the purge, as the delete request does. */
const deleteNow = (owner: AccessScope) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE workspaces SET deleted_at = UTC_TIMESTAMP(6) - INTERVAL 8 DAY, purge_after = UTC_TIMESTAMP(6) - INTERVAL 1 DAY WHERE id = ${owner.workspace_id}`;
    return yield* enqueueJob({ workspace_id: owner.workspace_id, kind: 'workspace.purge', work_key: 'purge', payload: { deleted_by: owner.principal.id }, requested_by: null });
  });

const counts = (workspace_id: WorkspaceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows: Record<string, number> = {};
    for (const table of [...PURGED_TABLES, 'workspace_members']) {
      const [row] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)} WHERE workspace_id = ${workspace_id}`;
      rows[table] = Number(row!.n);
    }
    return rows;
  });

const claim = Effect.map(claimJob(['workspace.purge'], 60_000), Option.getOrThrow);

layer(migratedDatabase, { timeout: 120_000 })('workspace purge', it => {
  it.effect('purges objects and rows exactly once across a worker restart and leaves other workspaces alone', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = memoryObjectStore();
      const a = yield* seed('Purged', store);
      const b = yield* seed('Kept', store);
      // A person in both workspaces keeps their principal; people and agents only in A go with it.
      yield* addMember({ workspace_id: a.workspace_id, principal_id: b.owner.principal.id, role: 'member' });
      const keptBefore = yield* counts(b.workspace_id);
      const jobId = yield* deleteNow(a.owner);
      const run = (lease: Lease) => Effect.provide(purgeWorkspace(lease.job), store.layer);

      // First attempt dies mid-purge: some objects are deleted, then the worker is gone without completing.
      store.failNext('delete', { after: 3 });
      const first = yield* claim;
      expect(yield* Effect.flip(run(first))).toMatchObject({ _tag: 'JobFailure', retryable: true });
      expect(store.deleted.length).toBeGreaterThanOrEqual(3);
      expect(store.deleted.length).toBeLessThan(a.keys.length);
      yield* sql`UPDATE jobs SET lease_until = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ${jobId}`;
      yield* sweepJobs;

      const second = yield* claim;
      const outcome = yield* run(second);
      // A rerun after the rows committed (a crash before completion) returns the same receipt and deletes nothing more.
      const rerun = yield* run(second);
      expect(rerun).toEqual(outcome);
      expect(yield* completeJob(second, outcome)).toBe(true);

      expect([...store.deleted].sort()).toEqual([...a.keys].sort());
      expect(b.keys.every(key => store.objects.has(key))).toBe(true);
      expect(Object.values(yield* counts(a.workspace_id)).every(n => n === 0)).toBe(true);
      expect(yield* counts(b.workspace_id)).toEqual(keptBefore);
      expect(outcome).toMatchObject({
        status: 'succeeded',
        result: {
          purged: true,
          deleted_by: a.owner.principal.id,
          prefixes: [`workspaces/${a.workspace_id}/`, `meetings/${a.workspace_id}/`],
          rows_deleted: { context_items: 2, meetings: 1, agent_credentials: 1, browser_sessions: 1, workspace_members: 5, principal_identities: 1, principals: 4 },
        },
      });
      const [shared] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM principals WHERE id = ${b.owner.principal.id}`;
      expect(Number(shared!.n)).toBe(1);
      const [tombstone] = yield* sql<{ name: string }>`SELECT name FROM workspaces WHERE id = ${a.workspace_id}`;
      expect(tombstone!.name).toBe('');
      const [job] = yield* sql<{ status: string; result: unknown }>`SELECT status, result FROM jobs WHERE id = ${jobId}`;
      expect(job).toMatchObject({ status: 'succeeded', result: outcome.status === 'succeeded' ? outcome.result : null });
    }),
  );

  it.effect('keeps the deployment-wide WorkOS sync job on the tombstone of the purged workspace', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = memoryObjectStore();
      const a = yield* seed('Anchor', store);
      const sync = yield* enqueueJob({ workspace_id: a.workspace_id, kind: 'workos.sync', work_key: 'events', payload: {}, requested_by: null });
      yield* deleteNow(a.owner);
      const lease = yield* claim;
      expect(yield* Effect.provide(purgeWorkspace(lease.job), store.layer)).toMatchObject({ status: 'succeeded', result: { purged: true } });
      const rows = yield* sql<{ id: string; kind: string }>`SELECT id, kind FROM jobs WHERE workspace_id = ${a.workspace_id} ORDER BY kind`;
      expect(rows.map(row => [row.id, row.kind])).toEqual([[sync, 'workos.sync'], [lease.job.id, 'workspace.purge']]);
    }),
  );

  it.effect('never purges a restored workspace', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = memoryObjectStore();
      const a = yield* seed('Restored', store);
      yield* deleteNow(a.owner);
      yield* sql`UPDATE workspaces SET deleted_at = NULL, purge_after = NULL WHERE id = ${a.workspace_id}`;
      const lease = yield* claim;
      expect(yield* Effect.provide(purgeWorkspace(lease.job), store.layer)).toMatchObject({ status: 'succeeded', result: { purged: false } });
      expect(store.deleted).toEqual([]);
      expect((yield* counts(a.workspace_id))['meetings']).toBe(1);
    }),
  );

  it.effect('covers every table holding workspace rows', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ name: string }>`SELECT table_name AS name FROM information_schema.columns
        WHERE table_schema = DATABASE() AND column_name = 'workspace_id' ORDER BY table_name`;
      expect(tables.map(table => table.name).sort()).toEqual([...PURGED_TABLES, 'jobs', 'workspace_members'].sort());
    }),
  );
});
