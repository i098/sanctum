/**
 * Worker handlers for authorized actions and research (plan section 10). External writes are
 * never replayed blindly: an attempt that reached the provider boundary without a recorded
 * outcome becomes `unknown`, and only its own late completion or a person can resolve it.
 */
import { SqlClient } from '@effect/sql';
import { ActionId, JobFailure, type JobId, MeetingId, type PrincipalId, type WorkspaceId } from '@sanctum/contracts';
import { Effect, type Either, Option, Schema } from 'effect';
import { type ActionRow, loadAction, requestAction } from './actions.ts';
import { requireScope, resolveAccess } from './auth.ts';
import { engineeringDefaults } from './config.ts';
import { executeIntegrationAction, type IntegrationFailure } from './integrations.ts';
import { planActions } from './planner.ts';

/** The claimed-job fields these handlers read; stated here so this module does not import the registry. */
interface Job {
  readonly id: JobId;
  readonly workspace_id: WorkspaceId;
  readonly payload: unknown;
  readonly requested_by: PrincipalId | null;
}

const storageFailure = (error: { readonly message: string }) => Effect.fail(new JobFailure({ message: error.message, retryable: true }));

/** The grant, its account and the grantee's membership are unchanged and active right before the write. */
const grantStillValid = (row: ActionRow) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [grant] = yield* sql<{ usable: number }>`
      SELECT (g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > UTC_TIMESTAMP(6)) AND g.version = ${row.grant_version}
        AND a.status = 'active' AND m.revoked_at IS NULL) AS usable
      FROM action_grants g
      JOIN integration_accounts a ON a.workspace_id = g.workspace_id AND a.id = g.account_id
      JOIN workspace_members m ON m.workspace_id = g.workspace_id AND m.principal_id = g.grantee_principal_id
      WHERE g.workspace_id = ${row.workspace_id} AND g.id = ${row.grant_id}`;
    return grant !== undefined && Number(grant.usable) === 1;
  });

/** A pause outcome while the workspace's submissions in the current window are at the budget. */
const budgetPause = (job: Job) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { perWindow, windowMs } = engineeringDefaults.actionBudget;
    const [budget] = yield* sql<{ used: number; oldest_age_us: string | null }>`
      SELECT COUNT(*) AS used, TIMESTAMPDIFF(MICROSECOND, MIN(started_at), UTC_TIMESTAMP(6)) AS oldest_age_us FROM actions
      WHERE workspace_id = ${job.workspace_id} AND started_at > UTC_TIMESTAMP(6) - INTERVAL ${windowMs * 1000} MICROSECOND`;
    if (Number(budget!.used) < perWindow) return null;
    const resume_after_ms = Math.max(1, windowMs - Math.floor(Number(budget!.oldest_age_us) / 1000));
    return { status: 'paused', resume_after_ms, reason: `Action budget of ${perWindow} per ${windowMs} ms reached` } as const;
  });

/** Decides inside one transaction whether this attempt may submit, and claims the submission. */
const startAttempt = (job: Job, action_id: ActionId) =>
  Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
    const where = sql`workspace_id = ${job.workspace_id} AND id = ${action_id}`;
    const settle = (state: 'unknown' | 'cancelled', error: { code: string; message: string }) =>
      Effect.as(
        sql`UPDATE actions SET state = ${state}, reconciliation = ${state === 'unknown' ? 'pending' : 'none'}, last_error = ${JSON.stringify(error)},
          updated_at = UTC_TIMESTAMP(6) WHERE ${where}`,
        { status: 'done', state } as const,
      );
    // Serializes budget accounting per workspace.
    yield* sql`SELECT id FROM workspaces WHERE id = ${job.workspace_id} FOR UPDATE`;
    const found = yield* loadAction(job.workspace_id, action_id, true);
    if (Option.isNone(found)) return { status: 'done', state: 'missing' } as const;
    const row = found.value;
    if (row.state === 'running') return yield* settle('unknown', { code: 'interrupted', message: 'A previous attempt stopped after submission began; outcome unknown' });
    if (row.state !== 'queued') return { status: 'done', state: row.state } as const;
    if (!(yield* grantStillValid(row))) return yield* settle('cancelled', { code: 'forbidden', message: 'Grant revoked, expired, changed or its account disconnected before execution' });
    const access = yield* resolveAccess({ workspace_id: job.workspace_id, principal_id: row.requested_by }).pipe(
      Effect.tap(scope => requireScope(scope, 'actions:request')),
      Effect.option,
    );
    if (Option.isNone(access)) return yield* settle('cancelled', { code: 'forbidden', message: 'Requester no longer has action access' });
    const pause = yield* budgetPause(job);
    if (pause) return pause;
    yield* sql`UPDATE actions SET state = 'running', attempts = attempts + 1, started_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6) WHERE ${where}`;
    return { status: 'submit', row, access: access.value, attempt: row.attempts + 1 } as const;
  })));

/**
 * Records the provider's answer for this attempt. A late answer (after another attempt marked
 * the action `unknown`) still lands and reconciles it; the attempt fence stops stale overwrites.
 */
const recordOutcome = (row: ActionRow, attempt: number, outcome: Either.Either<{ readonly receipt: Record<string, unknown>; readonly artifact: Uint8Array | null }, IntegrationFailure>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fence = sql`workspace_id = ${row.workspace_id} AND id = ${row.id} AND attempts = ${attempt}`;
    if (outcome._tag === 'Right') {
      yield* sql`UPDATE actions SET reconciliation = IF(state = 'unknown', 'reconciled', reconciliation), state = 'succeeded',
        provider_receipt = ${JSON.stringify(outcome.right.receipt)}, last_error = NULL, updated_at = UTC_TIMESTAMP(6)
        WHERE ${fence} AND state IN ('running', 'unknown')`;
      return;
    }
    const error = JSON.stringify({ code: outcome.left.ambiguous ? 'ambiguous' : 'provider_failed', message: outcome.left.message });
    yield* outcome.left.ambiguous
      ? sql`UPDATE actions SET state = 'unknown', reconciliation = 'pending', last_error = ${error}, updated_at = UTC_TIMESTAMP(6) WHERE ${fence} AND state = 'running'`
      : sql`UPDATE actions SET reconciliation = IF(state = 'unknown', 'reconciled', reconciliation), state = 'failed', last_error = ${error},
          updated_at = UTC_TIMESTAMP(6) WHERE ${fence} AND state IN ('running', 'unknown')`;
  });

const ActionPayload = Schema.Struct({ action_id: ActionId });

/** `action.execute`: payload `{ action_id }`, work key = action ID. */
export const executeAction = (job: Job) =>
  Effect.gen(function* () {
    const { action_id } = yield* Schema.decodeUnknown(ActionPayload)(job.payload);
    const start = yield* startAttempt(job, action_id);
    if (start.status === 'paused') return start;
    if (start.status === 'done') return { status: 'succeeded', result: { action_id, state: start.state } } as const;
    const { row } = start;
    const outcome = yield* Effect.either(
      executeIntegrationAction({
        access: start.access,
        account_id: row.account_id!,
        action_key: row.action_key,
        version: row.version,
        configuration_ref: row.configuration_ref ?? '',
        arguments: row.args,
        provider_idempotency_key: row.provider_idempotency_key,
      }),
    );
    yield* recordOutcome(row, start.attempt, outcome);
    const final = yield* loadAction(job.workspace_id, action_id);
    return { status: 'succeeded', result: { action_id, state: Option.getOrThrow(final).state } } as const;
  }).pipe(Effect.catchTags({ SqlError: storageFailure, ParseError: error => Effect.fail(new JobFailure({ message: error.message, retryable: false })) }));

const ResearchPayload = Schema.Struct({ meeting_id: Schema.NullOr(MeetingId), request: Schema.String.pipe(Schema.minLength(1)) });

/**
 * `research.run`: plan the request and submit each planned action through the same grant
 * gateway as any agent. Idempotency keys derive from the job ID, so a retried job never
 * requests twice. A rate-limited planner pauses the job until it may resume.
 */
export const runResearch = (job: Job) =>
  Effect.gen(function* () {
    const { meeting_id, request } = yield* Schema.decodeUnknown(ResearchPayload)(job.payload);
    if (job.requested_by === null) return yield* new JobFailure({ message: 'Research requires a requesting principal', retryable: false });
    const access = yield* resolveAccess({ workspace_id: job.workspace_id, principal_id: job.requested_by });
    const plan = yield* Effect.either(planActions(access, { meeting_id, request }));
    if (plan._tag === 'Left') {
      const { retryable, retry_after_ms, message } = plan.left;
      if (retryable && retry_after_ms !== undefined) return { status: 'paused', resume_after_ms: retry_after_ms, reason: message } as const;
      return yield* new JobFailure({ message, retryable });
    }
    const results = yield* Effect.forEach(plan.right, (input, index) =>
      requestAction(access, { ...input, meeting_id, idempotency_key: `research:${job.id}:${index}` }).pipe(
        Effect.map(output => ({ action_key: input.action_key, ...output })),
        Effect.catchAll(error => Effect.succeed({ action_key: input.action_key, refused: error._tag })),
      ),
    );
    return { status: 'succeeded', result: { actions: results } } as const;
  }).pipe(
    Effect.catchTags({
      Forbidden: error => Effect.fail(new JobFailure({ message: error.message, retryable: false })),
      ParseError: error => Effect.fail(new JobFailure({ message: error.message, retryable: false })),
    }),
  );
