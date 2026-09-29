/** Fixture accounts, grants, ledger rows and a fake provider behind `executeIntegrationAction`; nothing leaves the process. */
import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { type AccessScope, type ActionId, IntegrationAccountId, JobId, type JobKind, type MeetingId, type WorkspaceId } from '@sanctum/contracts';
import { Effect } from 'effect';
import type { executeIntegrationAction, IntegrationFailure } from '../../src/integrations.ts';
import type { ClaimedJob } from '../../src/job-handlers.ts';

type ExecuteInput = Parameters<typeof executeIntegrationAction>[0];

/** What the fake upstream does with the next submissions; `sent` is its outbox. */
export const provider = {
  mode: 'ok' as 'ok' | 'ambiguous_after_send' | 'reject' | 'hold',
  sent: [] as ExecuteInput[],
  /** In `hold` mode: resolves the in-flight submission as a late success. */
  release: null as (() => void) | null,
  reset() {
    this.mode = 'ok';
    this.sent = [];
    this.release = null;
  },
};

/** `vi.mock('../src/integrations.ts', ...)` factory body. */
export const fakeIntegrations = async (importOriginal: () => Promise<typeof import('../../src/integrations.ts')>) => {
  const original = await importOriginal();
  const fail = (message: string, ambiguous: boolean): IntegrationFailure => new original.IntegrationFailure({ message, status: null, retryable: ambiguous, ambiguous });
  return {
    ...original,
    executeIntegrationAction: (input: ExecuteInput) =>
      Effect.suspend(() => {
        if (provider.mode === 'reject') return Effect.fail(fail('Provider rejected the request before sending', false));
        provider.sent.push(input);
        const receipt = { message_id: `msg-${provider.sent.length}`, idempotency_key: input.provider_idempotency_key };
        if (provider.mode === 'ambiguous_after_send') return Effect.fail(fail('Timed out after submission', true));
        if (provider.mode === 'hold') return Effect.as(Effect.promise(() => new Promise<void>(resolve => (provider.release = resolve))), { receipt, artifact: null });
        return Effect.succeed({ receipt, artifact: null });
      }),
  };
};

export const seedAccount = (owner: AccessScope, status: 'active' | 'disconnected' = 'active') =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = IntegrationAccountId.make(randomUUID());
    yield* sql`
      INSERT INTO integration_accounts (id, workspace_id, owner_principal_id, external_user_id, provider_account_id, app_slug, status, created_at, updated_at)
      VALUES (${id}, ${owner.workspace_id}, ${owner.principal.id}, ${`user-${id}`}, ${`apn_${id}`}, 'gmail', ${status}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    return id;
  });

export const seedMeeting = (workspace_id: WorkspaceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = randomUUID() as MeetingId;
    yield* sql`
      INSERT INTO meetings (id, workspace_id, state, timezone, started_at, processing, created_at, updated_at)
      VALUES (${id}, ${workspace_id}, 'active', 'America/Los_Angeles', UTC_TIMESTAMP(6),
        ${JSON.stringify({ transcript: 'pending', notes: 'pending', memory: 'pending', recording: 'pending' })}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    return id;
  });

/** The ledger row `enqueueJob` wrote, as a worker would receive it on its next claim. */
export const queuedJob = (workspace_id: WorkspaceId, kind: JobKind, work_key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ id: string; payload: unknown; requested_by: string | null; attempts: number; lease_generation: string }>`
      SELECT id, payload, requested_by, attempts, lease_generation FROM jobs WHERE workspace_id = ${workspace_id} AND kind = ${kind} AND work_key = ${work_key}`;
    if (!row) throw new Error(`no ${kind} job for ${work_key}`);
    return {
      id: JobId.make(row.id),
      workspace_id,
      kind,
      work_key,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      requested_by: row.requested_by,
      source_revision: null,
      attempt: row.attempts + 1,
      lease_generation: Number(row.lease_generation) + 1,
    } as ClaimedJob;
  });

export const actionRow = (workspace_id: WorkspaceId, id: ActionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ state: string; reconciliation: string; attempts: number; last_error: unknown }>`
      SELECT state, reconciliation, attempts, last_error FROM actions WHERE workspace_id = ${workspace_id} AND id = ${id}`;
    return row!;
  });
