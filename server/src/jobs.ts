/**
 * Durable job ledger, enqueue side (plan sections 07 and 11): enqueue coalesces on an
 * active work key and joins the caller's transaction. Claiming, leases, fenced completion and
 * the worker loop live in job-runner.ts, which only the worker entrypoint imports.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import type { JobKind, PrincipalId, WorkspaceId } from '@sanctum/contracts';
import { Effect } from 'effect';
import { engineeringDefaults } from './config.ts';
import { addSeconds, now } from './sql-dialect.ts';

/** Failure message of a job whose requester lost access; restoring a workspace requeues the jobs that failed with it. */
export const REQUESTER_REFUSED = 'Requester is no longer authorized';

export interface EnqueueJob {
  readonly workspace_id: WorkspaceId;
  readonly kind: JobKind;
  readonly work_key: string;
  readonly payload: unknown;
  readonly requested_by: PrincipalId | null;
  readonly source_revision?: number;
  readonly delay_ms?: number;
  readonly max_attempts?: number;
  /** Make a re-armed row due no later than this request instead of restarting its timer (e.g. a turn threshold). */
  readonly expedite?: boolean;
}

/** A timestamp `ms` milliseconds from now, as a SQL fragment. */
export const later = (ms: number) => addSeconds(now, ms / 1000);

/**
 * Joins the caller's transaction. An active row with the same key is re-armed: latest payload
 * wins, the timer restarts (or, with `expedite`, moves no later than this request), and a running row returns to pending once its current run completes.
 * It reads nothing, so it may follow the transaction's own writes; a coalesced request keeps the existing row's id.
 */
export const enqueueJob = (input: EnqueueJob) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO jobs (id, workspace_id, kind, work_key, requested_by, source_revision, status, payload, available_at, max_attempts, created_at, updated_at)
          VALUES (${randomUUID()}, ${input.workspace_id}, ${input.kind}, ${input.work_key}, ${input.requested_by}, ${input.source_revision ?? null}, 'pending',
            ${JSON.stringify(input.payload)}, ${later(input.delay_ms ?? 0)}, ${input.max_attempts ?? engineeringDefaults.jobs.maxAttemptsByKind[input.kind] ?? 5}, ${now}, ${now})
          ON CONFLICT (workspace_id, kind, active_work_key) DO UPDATE SET
            rearmed = iif(jobs.status = 'running', 1, jobs.rearmed),
            attempts = iif(jobs.status = 'running', jobs.attempts, 0),
            available_at = iif(${input.expedite === true ? 1 : 0}, min(jobs.available_at, excluded.available_at), max(jobs.available_at, excluded.available_at)),
            payload = excluded.payload,
            requested_by = excluded.requested_by,
            source_revision = coalesce(excluded.source_revision, jobs.source_revision),
            max_attempts = excluded.max_attempts,
            updated_at = excluded.updated_at`;
      }),
    );
  });
