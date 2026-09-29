/**
 * Durable MySQL job ledger, enqueue side (plan sections 07 and 11): enqueue coalesces on an
 * active work key and joins the caller's transaction. Claiming, leases, fenced completion and
 * the worker loop live in job-runner.ts, which only the worker entrypoint imports.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import type { JobId, JobKind, PrincipalId, WorkspaceId } from '@sanctum/contracts';
import { Effect } from 'effect';

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

export const later = (sql: SqlClient.SqlClient, ms: number) => sql`UTC_TIMESTAMP(6) + INTERVAL ${Math.round(ms * 1000)} MICROSECOND`;

/**
 * Joins the caller's transaction. An active row with the same key is re-armed: latest payload
 * wins, the timer restarts, and a running row returns to pending once its current run completes.
 */
export const enqueueJob = (input: EnqueueJob) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO jobs (id, workspace_id, kind, work_key, requested_by, source_revision, status, payload, available_at, max_attempts, created_at, updated_at)
      VALUES (${randomUUID()}, ${input.workspace_id}, ${input.kind}, ${input.work_key}, ${input.requested_by}, ${input.source_revision ?? null}, 'pending',
        ${JSON.stringify(input.payload)}, ${later(sql, input.delay_ms ?? 0)}, ${input.max_attempts ?? 5}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)) AS new
      ON DUPLICATE KEY UPDATE
        rearmed = IF(jobs.status = 'running', 1, jobs.rearmed),
        attempts = IF(jobs.status = 'running', jobs.attempts, 0),
        available_at = GREATEST(jobs.available_at, new.available_at),
        payload = new.payload,
        requested_by = new.requested_by,
        source_revision = COALESCE(new.source_revision, jobs.source_revision),
        max_attempts = new.max_attempts,
        updated_at = new.updated_at`;
    const [row] = yield* sql<{ id: JobId }>`SELECT id FROM jobs
      WHERE workspace_id = ${input.workspace_id} AND kind = ${input.kind} AND active_work_key = ${input.work_key}`;
    return row!.id;
  });
