// stand-in: replaced by the kernel slice at integration
/** Job ledger core: enqueue, SKIP LOCKED claim, lease, fenced completion, bounded retry, worker loop. */
import { randomUUID } from 'node:crypto';
import { SqlClient, type SqlError } from '@effect/sql';
import { JobId, type JobKind, type PrincipalId, Unavailable, type WorkspaceId } from '@sanctum/contracts';
import { Effect } from 'effect';

export const runWorker = (handlers: Partial<Record<string, unknown>>) =>
  Effect.fail(new Unavailable({ message: `Job ledger not implemented; ${Object.keys(handlers).length} handlers registered`, retryable: false }));

export interface EnqueueJob {
  readonly workspace_id: WorkspaceId;
  readonly kind: JobKind;
  readonly work_key: string;
  readonly payload: unknown;
  readonly requested_by: PrincipalId | null;
  readonly source_revision?: number;
  readonly delay_ms?: number;
  readonly max_attempts?: number;
}

/** Inserts a pending job inside the caller's transaction; an active row with the same key is re-armed. */
export const enqueueJob = (input: EnqueueJob): Effect.Effect<JobId, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const delayMicros = (input.delay_ms ?? 0) * 1000;
    yield* sql`
      INSERT INTO jobs (id, workspace_id, kind, work_key, requested_by, source_revision, status, payload, available_at,
                        max_attempts, created_at, updated_at)
      VALUES (${randomUUID()}, ${input.workspace_id}, ${input.kind}, ${input.work_key}, ${input.requested_by},
              ${input.source_revision ?? null}, 'pending', ${JSON.stringify(input.payload)},
              UTC_TIMESTAMP(6) + INTERVAL ${delayMicros} MICROSECOND, ${input.max_attempts ?? 5}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)) AS new
      ON DUPLICATE KEY UPDATE payload = new.payload, available_at = new.available_at, updated_at = new.updated_at`;
    const [row] = yield* sql<{ id: string }>`
      SELECT id FROM jobs WHERE workspace_id = ${input.workspace_id} AND kind = ${input.kind} AND active_work_key = ${input.work_key}`;
    return JobId.make(row!.id);
  });
