/** Fixture accounts, grants, ledger rows and a fake provider behind `executeIntegrationAction`; nothing leaves the process. */
import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { type AccessScope, type ActionId, IntegrationAccountId, JobId, type JobKind, type MeetingId, type PrincipalId, type WorkspaceId } from '@sanctum/contracts';
import { Effect, Layer } from 'effect';
import { engineeringDefaults } from '../../src/config.ts';
import type { executeIntegrationAction, IntegrationFailure } from '../../src/integrations.ts';
import { LlmClient, makeLlm } from '../../src/llm.ts';
import { claimed } from './capture.ts';
import { fixturePipedream } from './pipedream.ts';

type ExecuteInput = Parameters<typeof executeIntegrationAction>[0];

/** What the fake upstream does with the next submissions; `sent` is its outbox. */
export const provider = {
  mode: 'ok' as 'ok' | 'ambiguous_after_send' | 'reject' | 'hold' | 'large_result',
  sent: [] as ExecuteInput[],
  /** In `hold` mode: resolves the in-flight submission as a late success. */
  release: null as (() => void) | null,
  reset() {
    this.mode = 'ok';
    this.sent = [];
    this.release = null;
  },
};

/** Services the action and research handlers require; with integrations and the planner mocked, nothing reaches them. */
export const actionServices = Layer.merge(fixturePipedream([]).layer, Layer.succeed(LlmClient, makeLlm(engineeringDefaults.modelRoles, {})));

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
        const artifact = provider.mode === 'large_result' ? new TextEncoder().encode(JSON.stringify({ rows: ['é'.repeat(20_000)] })) : null;
        return Effect.succeed({ receipt, artifact });
      }),
  };
};

export const seedAccount = (owner: AccessScope, status: 'active' | 'disconnected' = 'active', app = 'gmail') =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = IntegrationAccountId.make(randomUUID());
    yield* sql`
      INSERT INTO integration_accounts (id, workspace_id, owner_principal_id, external_user_id, provider_account_id, app_slug, status, created_at, updated_at)
      VALUES (${id}, ${owner.workspace_id}, ${owner.principal.id}, ${`user-${id}`}, ${`apn_${id}`}, ${app}, ${status}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    return id;
  });

/** Active credential carrying the agent's fixture scopes; workers re-resolve agent access from these. */
export const seedCredential = (owner: AccessScope, agent: AccessScope) =>
  Effect.flatMap(SqlClient.SqlClient, sql => sql`
    INSERT INTO agent_credentials (id, workspace_id, principal_id, owner_principal_id, token_hash, scopes, created_at)
    VALUES (${randomUUID()}, ${agent.workspace_id}, ${agent.principal.id}, ${owner.principal.id}, UNHEX(SHA2(${randomUUID()}, 256)), ${JSON.stringify(agent.scopes)}, UTC_TIMESTAMP(6))`);

/** Restricted meeting; each of `writers` gets write access. */
export const seedMeeting = (workspace_id: WorkspaceId, writers: ReadonlyArray<AccessScope> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = randomUUID() as MeetingId;
    yield* sql`
      INSERT INTO meetings (id, workspace_id, state, timezone, started_at, processing, created_at, updated_at)
      VALUES (${id}, ${workspace_id}, 'active', 'America/Los_Angeles', UTC_TIMESTAMP(6),
        ${JSON.stringify({ transcript: 'pending', notes: 'pending', memory: 'pending', recording: 'pending' })}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    for (const writer of writers) {
      yield* sql`INSERT INTO meeting_access (workspace_id, meeting_id, principal_id, access, granted_by, created_at)
        VALUES (${workspace_id}, ${id}, ${writer.principal.id}, 'write', ${writer.principal.id}, UTC_TIMESTAMP(6))`;
    }
    return id;
  });

/** The ledger row `enqueueJob` wrote, as a worker would receive it on its next claim. */
export const queuedJob = (workspace_id: WorkspaceId, kind: JobKind, work_key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ id: string; payload: unknown; requested_by: PrincipalId | null; attempts: number; lease_generation: string }>`
      SELECT id, payload, requested_by, attempts, lease_generation FROM jobs WHERE workspace_id = ${workspace_id} AND kind = ${kind} AND work_key = ${work_key}`;
    if (!row) throw new Error(`no ${kind} job for ${work_key}`);
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    return { ...claimed(workspace_id, kind, payload), id: JobId.make(row.id), work_key, requested_by: row.requested_by, attempt: row.attempts + 1, lease_generation: Number(row.lease_generation) + 1 };
  });

export const actionRow = (workspace_id: WorkspaceId, id: ActionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ state: string; reconciliation: string; attempts: number; last_error: unknown }>`
      SELECT state, reconciliation, attempts, last_error FROM actions WHERE workspace_id = ${workspace_id} AND id = ${id}`;
    return row!;
  });
