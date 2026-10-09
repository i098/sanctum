/**
 * Workspace deletion (plan 10.1 option A). The owner confirms with the exact workspace name; the
 * workspace is then marked deleted, which refuses every membership, session and agent credential
 * of it at once (auth.ts joins only live workspaces), and a `workspace.purge` job becomes due after
 * the grace period, during which the owner can restore it. The purge deletes the workspace's R2
 * objects by prefix, then its rows, and records a receipt.
 * Nothing else starts a purge: retention is still open (docs/DECISIONS.md).
 */
import { HttpApiBuilder } from '@effect/platform';
import { SqlClient, SqlSchema } from '@effect/sql';
import { type AccessScope, CurrentAccess, Forbidden, JobFailure, PrincipalId, WorkspaceId } from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Effect, Schema } from 'effect';
import { engineeringDefaults, workspacePurgeGraceDays } from './config.ts';
import { DbJson, DbUtc } from './db.ts';
import type { JobHandler } from './job-types.ts';
import { enqueueJob, REQUESTER_REFUSED } from './jobs.ts';
import { ObjectStore } from './providers/object-store.ts';
import { bumpPermissionRevision, write } from './store.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every table with workspace rows except `workspaces` and `jobs`, children before the rows they reference. */
export const PURGED_TABLES = [
  'context_events',
  'context_processed_segments',
  'context_items',
  'artifacts',
  'actions',
  'action_grants',
  'integration_accounts',
  'profile_embeddings',
  'speaker_attributions',
  'speaker_tracks',
  'voice_enrollments',
  'meeting_recordings',
  'boundary_events',
  'meeting_ranges',
  'meeting_access',
  'meetings',
  'transcript_coverage',
  'transcript_segments',
  'provider_connections',
  'recording_chunks',
  'capture_epochs',
  'listener_lease_claims',
  'listeners',
  'capture_groups',
  'profiles',
  'agent_credentials',
  'browser_sessions',
] as const;

const WorkspaceRow = Schema.Struct({ id: WorkspaceId, name: Schema.String, deleted_at: Schema.NullOr(DbUtc), purge_after: Schema.NullOr(DbUtc) });

const getWorkspace = (workspace_id: WorkspaceId) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    SqlSchema.single({
      Request: Schema.Void,
      Result: WorkspaceRow,
      execute: () => sql`SELECT id, name, deleted_at, purge_after FROM workspaces WHERE id = ${workspace_id}`,
    })(undefined),
  ).pipe(Effect.orDie);

/** Idempotent: deleting an already deleted workspace keeps the first grace period. */
const deleteWorkspace = (access: AccessScope, confirm_name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const days = yield* Effect.orDie(workspacePurgeGraceDays);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ name: string; deleted_at: unknown }>`SELECT name, deleted_at FROM workspaces WHERE id = ${access.workspace_id} FOR UPDATE`;
          // Compared in code: the column collation ignores case and accents.
          if (row!.name !== confirm_name) return yield* new Forbidden({ message: 'Type the workspace name exactly to confirm deletion' });
          if (row!.deleted_at !== null) return;
          yield* sql`UPDATE workspaces SET deleted_at = UTC_TIMESTAMP(6), purge_after = UTC_TIMESTAMP(6) + INTERVAL ${days} DAY WHERE id = ${access.workspace_id}`;
          yield* bumpPermissionRevision(access.workspace_id);
          // No requester: the worker would re-check it against the deleted workspace and refuse the job.
          yield* enqueueJob({
            workspace_id: access.workspace_id,
            kind: 'workspace.purge',
            work_key: 'purge',
            payload: { deleted_by: access.principal.id },
            requested_by: null,
            delay_ms: days * DAY_MS,
            max_attempts: engineeringDefaults.jobs.purgeMaxAttempts,
          });
        }),
      )
      .pipe(Effect.catchTag('SqlError', Effect.die));
    return yield* getWorkspace(access.workspace_id);
  });

/**
 * Undo while the grace period runs; after it the purge owns the workspace and restoring changes nothing.
 * Jobs the worker failed because the deletion refused their requester run again; queued actions the
 * executor cancelled for the same reason stay cancelled, and so does every other failed job.
 */
const restoreWorkspace = (access: AccessScope) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [due] = yield* sql`SELECT id FROM workspaces
            WHERE id = ${access.workspace_id} AND deleted_at IS NOT NULL AND purge_after > UTC_TIMESTAMP(6) FOR UPDATE`;
          if (due === undefined) return;
          // IGNORE: a newer active job with the same work key already covers the work.
          yield* sql`UPDATE IGNORE jobs SET status = 'pending', attempts = 0, available_at = UTC_TIMESTAMP(6), last_error = NULL, updated_at = UTC_TIMESTAMP(6)
            WHERE workspace_id = ${access.workspace_id} AND status = 'failed' AND last_error->>'$.message' = ${REQUESTER_REFUSED}
              AND updated_at >= (SELECT deleted_at FROM workspaces WHERE id = ${access.workspace_id})`;
          yield* sql`UPDATE workspaces SET deleted_at = NULL, purge_after = NULL WHERE id = ${access.workspace_id}`;
          yield* bumpPermissionRevision(access.workspace_id);
          yield* sql`UPDATE jobs SET status = 'cancelled', updated_at = UTC_TIMESTAMP(6)
            WHERE workspace_id = ${access.workspace_id} AND kind = 'workspace.purge' AND status = 'pending'`;
        }),
      )
      .pipe(Effect.orDie);
    return yield* getWorkspace(access.workspace_id);
  });

export const WorkspaceLive = HttpApiBuilder.group(SanctumApi, 'workspace', handlers =>
  handlers
    .handle('getWorkspace', () => Effect.flatMap(CurrentAccess, access => getWorkspace(access.workspace_id)))
    .handle('deleteWorkspace', ({ payload }) => Effect.flatMap(CurrentAccess, access => deleteWorkspace(access, payload.confirm_name)))
    .handle('restoreWorkspace', () => Effect.flatMap(CurrentAccess, restoreWorkspace)),
);

const PurgeReceipt = Schema.Struct({
  purged: Schema.Literal(true),
  deleted_by: PrincipalId,
  prefixes: Schema.Array(Schema.String),
  rows_deleted: Schema.Record({ key: Schema.String, value: Schema.Number }),
});
type PurgeReceipt = typeof PurgeReceipt.Type;

const Payload = Schema.Struct({ deleted_by: PrincipalId });

/** Deletes every object under `prefix` page by page; a crash keeps what was deleted, and the rerun continues. */
const deletePrefix = (prefix: string) =>
  Effect.gen(function* () {
    const store = yield* ObjectStore;
    let first: string | undefined;
    for (;;) {
      const keys = yield* store.list(prefix);
      if (keys.length === 0) return;
      if (keys[0] === first) return yield* new JobFailure({ message: `Objects under ${prefix} remain after delete`, retryable: true });
      first = keys[0];
      yield* Effect.forEach(keys, key => store.delete(key), { concurrency: 16, discard: true });
    }
  }).pipe(Effect.catchTag('ObjectStoreError', error => new JobFailure({ message: `Purge ${error.operation} failed: ${error.message}`, retryable: true })));

/**
 * `workspace.purge`: objects first, then rows in one transaction that also writes the receipt onto
 * this job, so a rerun after a crash returns that receipt instead of counting nothing twice. The
 * `workspaces` row stays as a tombstone with its name cleared: the job row holding the receipt references it.
 */
export const purgeWorkspace: JobHandler<SqlClient.SqlClient | ObjectStore> = job =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const workspace_id = job.workspace_id;
    const { deleted_by } = yield* Schema.decodeUnknown(Payload)(job.payload).pipe(
      Effect.mapError(() => new JobFailure({ message: 'Invalid workspace.purge payload', retryable: false })),
    );
    const [finished] = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ result: DbJson(PurgeReceipt) }),
      execute: () => sql`SELECT result FROM jobs WHERE id = ${job.id} AND result->>'$.purged' = 'true'`,
    })(undefined).pipe(Effect.orDie);
    if (finished !== undefined) return { status: 'succeeded' as const, result: finished.result };
    // Locking read: a restore committing at the deadline is seen here, and none can start after it.
    const due = yield* sql.withTransaction(sql`SELECT id FROM workspaces
      WHERE id = ${workspace_id} AND deleted_at IS NOT NULL AND purge_after <= UTC_TIMESTAMP(6) FOR UPDATE`);
    if (due.length === 0) return { status: 'succeeded' as const, result: { purged: false, reason: 'Workspace is not deleted or not yet due' } };

    const prefixes = [`workspaces/${workspace_id}/`, `meetings/${workspace_id}/`];
    yield* Effect.forEach(prefixes, deletePrefix, { discard: true });

    const receipt = yield* sql.withTransaction(
      Effect.gen(function* () {
        const members = yield* sql<{ principal_id: string }>`SELECT principal_id FROM workspace_members WHERE workspace_id = ${workspace_id}`;
        const rows_deleted: Record<string, number> = {};
        const purge = (table: string, extra = sql`TRUE`) =>
          Effect.map(write(sql`DELETE FROM ${sql(table)} WHERE workspace_id = ${workspace_id} AND ${extra}`), result => void (rows_deleted[table] = result.affectedRows));
        // Revisions supersede earlier revisions of the same table; unlink them so one DELETE can remove all.
        yield* sql`UPDATE context_items SET supersedes_id = NULL, supersedes_revision = NULL WHERE workspace_id = ${workspace_id}`;
        for (const table of PURGED_TABLES) yield* purge(table);
        yield* purge('jobs', sql`id <> ${job.id}`);
        yield* purge('workspace_members');
        // Principals left with no membership in any workspace (agents, devices, people only here) go with it.
        if (members.length > 0) {
          const orphaned = sql`IN ${sql.in(members.map(member => member.principal_id))} AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.principal_id = x.id)`;
          rows_deleted['principal_identities'] = (yield* write(sql`DELETE i FROM principal_identities i JOIN principals x ON x.id = i.principal_id WHERE x.id ${orphaned}`)).affectedRows;
          rows_deleted['principals'] = (yield* write(sql`DELETE x FROM principals x WHERE x.id ${orphaned}`)).affectedRows;
        }
        yield* sql`UPDATE workspaces SET name = '' WHERE id = ${workspace_id}`;
        const receipt: PurgeReceipt = { purged: true, deleted_by, prefixes, rows_deleted };
        yield* sql`UPDATE jobs SET result = ${JSON.stringify(receipt)} WHERE id = ${job.id}`;
        return receipt;
      }),
    );
    return { status: 'succeeded' as const, result: receipt };
  }).pipe(Effect.catchTag('SqlError', error => new JobFailure({ message: `Database error: ${error.message}`, retryable: true })));
