/**
 * Worker handlers for authorized actions and research (plan section 10). External writes are
 * never replayed blindly: an attempt that reached the provider boundary without a recorded
 * outcome becomes `unknown`, and only its own late completion or a person can resolve it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { type AccessScope, ActionId, JobFailure, type JobId, MeetingId, type PrincipalId, type RequestActionInput, type WorkspaceId } from '@sanctum/contracts';
import { Effect, Either, Fiber, Option, Schedule, Schema } from 'effect';
import { type ActionRow, findByIdempotencyKey, loadAction, requestAction } from './actions.ts';
import { authorizeMeeting, requireScope, resolveAccess } from './auth.ts';
import { engineeringDefaults } from './config.ts';
import { executeIntegrationAction, IntegrationFailure } from './integrations.ts';
import { type Plan, type PlanInput, planWork } from './planner.ts';
import { offeredActions, type WebResearch, webResearch } from './research.ts';

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
      Effect.map(Option.some),
      Effect.catchTag('Forbidden', () => Effect.succeedNone),
    );
    if (Option.isNone(access)) return yield* settle('cancelled', { code: 'forbidden', message: 'Requester no longer has action access' });
    const pause = yield* budgetPause(job);
    if (pause) return pause;
    yield* sql`UPDATE actions SET state = 'running', attempts = attempts + 1, started_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6) WHERE ${where}`;
    return { status: 'submit', row, access: access.value, attempt: row.attempts + 1 } as const;
  })));

/**
 * Keeps a provider result over the model-facing output budget as an `action_output` artifact
 * (plan section 10: receipts stay bounded, full results stay readable by reference).
 */
const storeArtifact = (row: ActionRow, attempt: number, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = randomUUID();
    yield* sql`INSERT INTO artifacts (id, workspace_id, meeting_id, kind, title, content_type, content, sha256, provenance, created_by, created_at)
      VALUES (${id}, ${row.workspace_id}, ${row.meeting_id}, 'action_output', ${`${row.action_key} result`}, 'application/json',
        ${new TextDecoder().decode(bytes)}, ${createHash('sha256').update(bytes).digest()}, ${JSON.stringify({ action_id: row.id, attempt })},
        ${row.requested_by}, UTC_TIMESTAMP(6))`;
    return id;
  });

/**
 * Records the provider's answer for this attempt. A late answer (after another attempt marked
 * the action `unknown`) still lands and reconciles it; the attempt fence stops stale overwrites.
 */
const recordOutcome = (row: ActionRow, attempt: number, outcome: Either.Either<{ readonly receipt: Record<string, unknown>; readonly artifact: Uint8Array | null }, IntegrationFailure>) =>
  Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
    const fence = sql`workspace_id = ${row.workspace_id} AND id = ${row.id} AND attempts = ${attempt}`;
    if (outcome._tag === 'Right') {
      const { artifact } = outcome.right;
      const artifact_id = artifact === null ? null : yield* storeArtifact(row, attempt, artifact);
      const receipt = artifact_id === null ? outcome.right.receipt : { ...outcome.right.receipt, artifact_id };
      yield* sql`UPDATE actions SET reconciliation = IF(state = 'unknown', 'reconciled', reconciliation), state = 'succeeded',
        provider_receipt = ${JSON.stringify(receipt)}, last_error = NULL, updated_at = UTC_TIMESTAMP(6)
        WHERE ${fence} AND state IN ('running', 'unknown')`;
      return;
    }
    const error = JSON.stringify({ code: outcome.left.ambiguous ? 'ambiguous' : 'provider_failed', message: outcome.left.message });
    yield* outcome.left.ambiguous
      ? sql`UPDATE actions SET state = 'unknown', reconciliation = 'pending', last_error = ${error}, updated_at = UTC_TIMESTAMP(6) WHERE ${fence} AND state = 'running'`
      : sql`UPDATE actions SET reconciliation = IF(state = 'unknown', 'reconciled', reconciliation), state = 'failed', last_error = ${error},
          updated_at = UTC_TIMESTAMP(6) WHERE ${fence} AND state IN ('running', 'unknown')`;
  })));

/**
 * Sends one attempt and records its answer from a daemon that outlives this handler. No answer
 * within the submit timeout, or an interrupt of the wait (job ceiling, lost lease, shutdown), records `unknown` now; the
 * late answer still settles the row.
 */
const submit = (row: ActionRow, access: Effect.Effect.Success<ReturnType<typeof resolveAccess>>, attempt: number) =>
  Effect.gen(function* () {
    const sending = yield* Effect.forkDaemon(Effect.either(
      executeIntegrationAction({
        access,
        account_id: row.account_id!,
        action_key: row.action_key,
        version: row.version,
        configuration_ref: row.configuration_ref ?? '',
        arguments: row.args,
        provider_idempotency_key: row.provider_idempotency_key,
      }),
    ).pipe(Effect.flatMap(outcome => Effect.retry(recordOutcome(row, attempt, outcome), { schedule: Schedule.exponential('100 millis'), times: 5 }))));
    const answered = yield* Effect.timeoutOption(Fiber.join(sending), engineeringDefaults.actionSubmitTimeoutMs);
    if (Option.isSome(answered)) return;
    const timedOut = new IntegrationFailure({ message: 'No provider answer after submission', status: null, retryable: false, ambiguous: true });
    yield* recordOutcome(row, attempt, Either.left(timedOut));
  }).pipe(Effect.onInterrupt(() => {
    const stopped = new IntegrationFailure({ message: 'The attempt was stopped after submission began', status: null, retryable: false, ambiguous: true });
    return Effect.ignore(recordOutcome(row, attempt, Either.left(stopped)));
  }));

const ActionPayload = Schema.Struct({ action_id: ActionId });

/** `action.execute`: payload `{ action_id }`, work key = action ID. */
export const executeAction = (job: Job) =>
  Effect.gen(function* () {
    const { action_id } = yield* Schema.decodeUnknown(ActionPayload)(job.payload);
    const start = yield* startAttempt(job, action_id);
    if (start.status === 'paused') return start;
    if (start.status === 'done') return { status: 'succeeded', result: { action_id, state: start.state } } as const;
    yield* submit(start.row, start.access, start.attempt);
    const final = yield* loadAction(job.workspace_id, action_id);
    return { status: 'succeeded', result: { action_id, state: Option.getOrThrow(final).state } } as const;
  }).pipe(Effect.catchTags({ SqlError: storageFailure, ParseError: error => Effect.fail(new JobFailure({ message: error.message, retryable: false })) }));

const ResearchPayload = Schema.Struct({ meeting_id: Schema.NullOr(MeetingId), request: Schema.String.pipe(Schema.minLength(1)) });

/**
 * Requests one planned action; with `researched`, a key conflict means an earlier attempt of the
 * job requested it with other research-written content, so that action is reported.
 */
const requestPlanned = (access: AccessScope, input: typeof RequestActionInput.Type, researched: boolean) =>
  requestAction(access, input).pipe(
    Effect.map(output => ({ action_key: input.action_key, ...output })),
    Effect.catchAll(error =>
      Effect.gen(function* () {
        const earlier = error._tag === 'HashConflict' && researched ? yield* findByIdempotencyKey(access, input.idempotency_key) : Option.none();
        return Option.isSome(earlier)
          ? { action_key: input.action_key, action_id: earlier.value.id, state: earlier.value.state, already_requested: true }
          : { action_key: input.action_key, refused: error._tag };
      }),
    ),
  );

type ResearchPass = {
  readonly found: WebResearch | { readonly refused: string } | null;
  readonly second: Plan | null;
  /** The actions to request: the plan's without research, the research pass's after it, none when it was refused. */
  readonly planned: Plan['actions'];
};

/** Web research when the plan asks for it, then the research pass over the actions planned with it; a spent allowance is a refusal. */
const researchPass = (job: Job & { readonly requested_by: PrincipalId }, access: AccessScope, input: { meeting_id: MeetingId; request: string; offered: PlanInput['actions']; plan: Plan }) =>
  Effect.gen(function* () {
    const { meeting_id, request, offered, plan } = input;
    if (!plan.web_research) return { found: null, second: null, planned: plan.actions };
    const found = yield* webResearch(job, meeting_id, request).pipe(Effect.catchTag('AllowanceSpent', error => Effect.succeed({ refused: error.message })));
    if ('refused' in found || plan.actions.length === 0) return { found, second: null, planned: [] };
    const second = yield* planWork(access, { meeting_id, request, actions: offered, research: { text: found.text, sources: found.sources, planned: plan.actions, job_id: job.id } });
    return { found, second, planned: second.actions };
  });

/**
 * Why `research.run` requested nothing, when that needs saying; `offered` already tells whether any
 * granted action matched the request, and dropped proposals are reported with their reasons.
 */
const researchOutcome = (plan: Plan, pass: ResearchPass, requested: number) => {
  if (pass.found !== null && 'refused' in pass.found && plan.actions.length > 0) return `No action requested: ${plan.actions.map(action => action.action_key).join(', ')} was planned together with the refused web research`;
  if (pass.second?.rejected) return `No action requested: ${pass.second.rejected}`;
  if (pass.found === null && requested === 0 && plan.rejected === undefined) return 'Nothing to do: no offered action fits the request, and it asked for no web research';
  return null;
};

/** The cited research the job stored, or why there was none. */
const researchSummary = (found: ResearchPass['found']) =>
  found === null || 'refused' in found ? found : { artifact_id: found.artifact_id, context_item_id: found.context_item_id, sources: found.sources };

/**
 * `research.run`: find and inspect the requester's granted actions that match the request, let the
 * planner decide on web research and fill in actions, then research first; actions planned with
 * research are planned again from the cited research, which may change only their content fields,
 * and none is requested when research is refused or that pass changes anything else. Each planned
 * action is submitted through the same grant gateway as any agent. A job that stored its research
 * does not pay for it again, and each further paid attempt counts against the allowance. Planned
 * idempotency keys derive from each action's arguments, and after research from the job and its
 * non-content arguments, so a retried or resumed job does not request the same action twice.
 * Dropped proposals are reported with their reasons, and nothing to do is reported as the outcome,
 * never an empty success.
 */
export const runResearch = (job: Job) =>
  Effect.gen(function* () {
    const { meeting_id, request } = yield* Schema.decodeUnknown(ResearchPayload)(job.payload);
    // Research plans over integration actions a person's grants own, so it never runs as the system actor.
    if (job.requested_by === null) return { status: 'succeeded', result: { skipped: 'Research needs a requesting principal; nobody asked for this run' } } as const;
    const access = yield* resolveAccess({ workspace_id: job.workspace_id, principal_id: job.requested_by });
    if (meeting_id === null) return yield* new JobFailure({ message: 'Research planning needs a meeting', retryable: false });
    yield* authorizeMeeting(access, meeting_id, 'write');
    const offered = yield* offeredActions(access, meeting_id, request);
    const plan = yield* planWork(access, { meeting_id, request, actions: offered });
    const pass = yield* researchPass({ ...job, requested_by: job.requested_by }, access, { meeting_id, request, offered, plan });
    const actions = yield* Effect.forEach(pass.planned, input => requestPlanned(access, { ...input, meeting_id }, pass.second !== null));
    const outcome = researchOutcome(plan, pass, actions.length);
    if (outcome) yield* Effect.logInfo('research.run did nothing', { job_id: job.id, outcome });
    const extra = { ...(plan.rejected ? { dropped: plan.rejected } : {}), ...(outcome ? { outcome } : {}) };
    return { status: 'succeeded', result: { offered: offered.map(action => action.action_key), research: researchSummary(pass.found), actions, ...extra } } as const;
  }).pipe(
    Effect.catchTags({
      // A rate-limited model pauses the job until it may resume; any other model failure fails the attempt truthfully.
      Unavailable: error =>
        error.retryable && error.retry_after_ms !== undefined
          ? Effect.succeed({ status: 'paused', resume_after_ms: error.retry_after_ms, reason: error.message } as const)
          : Effect.fail(new JobFailure({ message: error.message, retryable: error.retryable })),
      Forbidden: error => Effect.fail(new JobFailure({ message: error.message, retryable: false })),
      NotFound: error => Effect.fail(new JobFailure({ message: error.message, retryable: false })),
      ParseError: error => Effect.fail(new JobFailure({ message: error.message, retryable: false })),
      ConfigError: error => Effect.fail(new JobFailure({ message: `Research settings: ${error}`, retryable: false })),
      SqlError: storageFailure,
    }),
  );
