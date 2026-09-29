import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, type ActionId, type IntegrationAccountId, type MeetingId, Unavailable } from '@sanctum/contracts';
import { Effect } from 'effect';
import { beforeEach, vi } from 'vitest';
import { createActionGrant, getActionReceipt, requestAction, resolveAction, revokeActionGrant } from '../src/actions.ts';
import { executeAction, runResearch } from '../src/executor.ts';
import { planActions } from '../src/planner.ts';
import { withDatabase } from './support/database.ts';
import { actionRow, provider, queuedJob, seedAccount, seedMeeting } from './support/actions.ts';
import { seedWorkspace } from './support/fixtures.ts';

vi.mock('../src/integrations.ts', async importOriginal => {
  const { fakeIntegrations } = await import('./support/actions.ts');
  return fakeIntegrations(importOriginal as never);
});
vi.mock('../src/planner.ts', () => ({ planActions: vi.fn() }));

beforeEach(() => provider.reset());

const SEND = 'gmail-send-email';

const request = (overrides: Partial<Parameters<typeof requestAction>[1]> = {}) => ({
  action_key: SEND,
  configuration_ref: 'cfg-1',
  version: '0.1.4',
  arguments: { to: 'a@example.com', subject: 'Notes' },
  meeting_id: null,
  idempotency_key: 'send-notes-1',
  ...overrides,
});

/** Owner (human, owns the Gmail account), a member and an agent granted `SEND` to one recipient. */
const setup = (grant: { meeting_id?: MeetingId | null; expires_at?: string | null; restrictions?: Record<string, ReadonlyArray<unknown>> } = {}) =>
  Effect.gen(function* () {
    const [owner, member, agent] = yield* seedWorkspace('Actions', ['owner', 'member', 'agent']);
    const account = yield* seedAccount(owner!);
    const created = yield* createActionGrant(owner!, {
      grantee: agent!.principal.id,
      action_key: SEND,
      account_id: account,
      meeting_id: grant.meeting_id ?? null,
      restrictions: grant.restrictions ?? { to: ['a@example.com'] },
      expires_at: (grant.expires_at ?? null) as never,
    });
    return { owner: owner!, member: member!, agent: agent!, account, grant: created };
  });

const execute = (access: AccessScope, action_id: ActionId) =>
  Effect.flatMap(queuedJob(access.workspace_id, 'action.execute', action_id), executeAction);

describe('action gateway', () => {
  it.effect('executes a granted action once with a truthful receipt and a stable provider key', () =>
    withDatabase(
      Effect.gen(function* () {
        const { agent, account, grant } = yield* setup();
        const queued = yield* requestAction(agent, request());
        expect(queued.state).toBe('queued');
        expect(yield* execute(agent, queued.action_id)).toEqual({ status: 'succeeded', result: { action_id: queued.action_id, state: 'succeeded' } });
        // Duplicate delivery of the same job never submits again.
        yield* execute(agent, queued.action_id);
        expect(provider.sent).toHaveLength(1);
        expect(provider.sent[0]).toMatchObject({ account_id: account, action_key: SEND, version: '0.1.4', configuration_ref: 'cfg-1', provider_idempotency_key: `sanctum:${queued.action_id}` });
        const receipt = yield* getActionReceipt(agent, queued.action_id);
        expect(receipt).toMatchObject({
          state: 'succeeded',
          attempts: 1,
          reconciliation: 'none',
          grant: { id: grant.id, version: 1 },
          provider_receipt: { message_id: 'msg-1', idempotency_key: `sanctum:${queued.action_id}` },
        });
        expect(receipt.args_sha256).toMatch(/^[0-9a-f]{64}$/);
      }),
      { migrated: true },
    ));

  it.effect('deduplicates repeated requests and rejects a reused key with different content', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { agent } = yield* setup();
        const first = yield* requestAction(agent, request());
        // Key order does not change the request identity.
        const again = yield* requestAction(agent, request({ arguments: { subject: 'Notes', to: 'a@example.com' } }));
        expect(again).toEqual(first);
        const conflict = yield* Effect.flip(requestAction(agent, request({ arguments: { to: 'a@example.com', subject: 'Other' } })));
        expect(conflict._tag).toBe('HashConflict');
        const receipt = yield* getActionReceipt(agent, first.action_id);
        expect(conflict).toMatchObject({ existing_sha256: receipt.args_sha256 });
        const [counts] = yield* sql<{ actions: string; jobs: string }>`
          SELECT (SELECT COUNT(*) FROM actions) AS actions, (SELECT COUNT(*) FROM jobs WHERE kind = 'action.execute') AS jobs`;
        expect(counts).toEqual({ actions: '1', jobs: '1' });
      }),
      { migrated: true },
    ));

  it.effect('refuses requests no active grant covers', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { owner, member, agent, account, grant } = yield* setup();
        const refused = (access: AccessScope, input: ReturnType<typeof request>) => Effect.map(Effect.flip(requestAction(access, input)), error => error._tag);
        expect(yield* refused(member, request())).toBe('Forbidden'); // not the grantee
        expect(yield* refused(agent, request({ action_key: 'gmail-delete-email' }))).toBe('Forbidden');
        expect(yield* refused(agent, request({ arguments: { to: 'evil@example.com', subject: 'x' } }))).toBe('Forbidden');
        expect(yield* refused(agent, request({ arguments: { to: ['a@example.com', 'evil@example.com'] } }))).toBe('Forbidden');
        expect(yield* refused(agent, request({ arguments: { subject: 'no recipient field' } }))).toBe('Forbidden');
        const device = { ...agent, role: 'device' as const, scopes: ['capture:ingest' as const] };
        expect(yield* Effect.flip(requestAction(device, request()))).toMatchObject({ _tag: 'Forbidden', required_scope: 'actions:request' });

        const meetingA = yield* seedMeeting(owner.workspace_id);
        const meetingB = yield* seedMeeting(owner.workspace_id);
        for (const meeting of [meetingA, meetingB]) {
          yield* sql`INSERT INTO meeting_access (workspace_id, meeting_id, principal_id, access, granted_by, created_at)
            VALUES (${owner.workspace_id}, ${meeting}, ${member.principal.id}, 'write', ${owner.principal.id}, UTC_TIMESTAMP(6))`;
        }
        const scoped = yield* createActionGrant(owner, { grantee: member.principal.id, action_key: SEND, account_id: account, meeting_id: meetingA, restrictions: {}, expires_at: null });
        expect(yield* refused(member, request({ meeting_id: meetingB }))).toBe('Forbidden');
        expect((yield* requestAction(member, request({ meeting_id: meetingA }))).state).toBe('queued');
        expect(scoped.meeting_id).toBe(meetingA);

        yield* sql`UPDATE action_grants SET expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ${grant.id}`;
        expect(yield* refused(agent, request({ idempotency_key: 'expired' }))).toBe('Forbidden');
        yield* sql`UPDATE action_grants SET expires_at = NULL WHERE id = ${grant.id}`;
        expect((yield* requestAction(agent, request({ idempotency_key: 'valid-again' }))).state).toBe('queued');
        yield* sql`UPDATE integration_accounts SET status = 'disconnected' WHERE id = ${account}`;
        expect(yield* refused(agent, request({ idempotency_key: 'disconnected' }))).toBe('Forbidden');
        yield* sql`UPDATE integration_accounts SET status = 'active' WHERE id = ${account}`;
        yield* revokeActionGrant(owner, grant.id);
        expect(yield* refused(agent, request({ idempotency_key: 'revoked' }))).toBe('Forbidden');
      }),
      { migrated: true },
    ));

  it.effect('cancels a queued action whose grant is revoked before the worker submits it', () =>
    withDatabase(
      Effect.gen(function* () {
        const { owner, agent, grant } = yield* setup();
        const queued = yield* requestAction(agent, request());
        const revoked = yield* revokeActionGrant(owner, grant.id);
        expect(revoked).toMatchObject({ version: 2, revoked_at: expect.any(String) });
        yield* execute(agent, queued.action_id);
        expect(provider.sent).toHaveLength(0);
        expect(yield* actionRow(agent.workspace_id, queued.action_id)).toMatchObject({ state: 'cancelled', attempts: 0, last_error: { code: 'forbidden' } });
      }),
      { migrated: true },
    ));

  it.effect('records a timeout after upstream success as unknown, never replays it, and lets a person resolve it', () =>
    withDatabase(
      Effect.gen(function* () {
        const { owner, agent } = yield* setup();
        provider.mode = 'ambiguous_after_send';
        const queued = yield* requestAction(agent, request());
        yield* execute(agent, queued.action_id);
        expect(yield* actionRow(agent.workspace_id, queued.action_id)).toMatchObject({ state: 'unknown', reconciliation: 'pending', last_error: { code: 'ambiguous' } });
        provider.mode = 'ok';
        yield* execute(agent, queued.action_id);
        expect(provider.sent).toHaveLength(1);
        expect((yield* Effect.flip(resolveAction(agent, queued.action_id, { outcome: 'succeeded', provider_receipt: null })))._tag).toBe('Forbidden');
        const resolved = yield* resolveAction(owner, queued.action_id, { outcome: 'succeeded', provider_receipt: { message_id: 'checked-in-gmail' } });
        expect(resolved).toMatchObject({ state: 'succeeded', reconciliation: 'reconciled', provider_receipt: { message_id: 'checked-in-gmail' } });
        expect((yield* Effect.flip(resolveAction(owner, queued.action_id, { outcome: 'failed', provider_receipt: null })))._tag).toBe('Forbidden');
      }),
      { migrated: true },
    ));

  it.effect('marks a definite provider rejection failed without retrying', () =>
    withDatabase(
      Effect.gen(function* () {
        const { agent } = yield* setup();
        provider.mode = 'reject';
        const queued = yield* requestAction(agent, request());
        yield* execute(agent, queued.action_id);
        yield* execute(agent, queued.action_id);
        expect(yield* actionRow(agent.workspace_id, queued.action_id)).toMatchObject({ state: 'failed', attempts: 1, reconciliation: 'none', last_error: { code: 'provider_failed' } });
      }),
      { migrated: true },
    ));

  it.effect('lets only the human account owner grant, and hides receipts across principals and workspaces', () =>
    withDatabase(
      Effect.gen(function* () {
        const { owner, member, agent, account, grant } = yield* setup();
        const input = { grantee: agent.principal.id, action_key: SEND, account_id: account as IntegrationAccountId, meeting_id: null, restrictions: {}, expires_at: null };
        expect((yield* Effect.flip(createActionGrant(agent, input)))._tag).toBe('Forbidden');
        expect((yield* Effect.flip(createActionGrant(member, input)))._tag).toBe('NotFound');
        expect((yield* Effect.flip(revokeActionGrant(member, grant.id)))._tag).toBe('NotFound');
        expect(grant).toMatchObject({ owner: owner.principal.id, grantee: agent.principal.id, app: 'gmail', version: 1, revoked_at: null });

        const queued = yield* requestAction(agent, request());
        expect((yield* getActionReceipt(owner, queued.action_id)).state).toBe('queued');
        expect((yield* Effect.flip(getActionReceipt(member, queued.action_id)))._tag).toBe('NotFound');
        const [stranger] = yield* seedWorkspace('Elsewhere', ['owner']);
        expect((yield* Effect.flip(getActionReceipt(stranger!, queued.action_id)))._tag).toBe('NotFound');
      }),
      { migrated: true },
    ));
});

describe('research.run', () => {
  it.effect('submits planned actions through the grant gateway exactly once per job', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { agent } = yield* setup();
        vi.mocked(planActions).mockReturnValue(Effect.succeed([request({ idempotency_key: 'ignored' }), request({ action_key: 'slack-send-message' })]));
        yield* sql`INSERT INTO jobs (id, workspace_id, kind, work_key, requested_by, status, payload, available_at, max_attempts, created_at, updated_at)
          VALUES (UUID(), ${agent.workspace_id}, 'research.run', 'follow-up', ${agent.principal.id}, 'pending', ${JSON.stringify({ meeting_id: null, request: 'Email the notes' })},
            UTC_TIMESTAMP(6), 3, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
        const job = yield* queuedJob(agent.workspace_id, 'research.run', 'follow-up');
        const first = yield* runResearch(job);
        expect(first).toMatchObject({
          status: 'succeeded',
          result: { actions: [{ action_key: SEND, state: 'queued' }, { action_key: 'slack-send-message', refused: 'Forbidden' }] },
        });
        expect(yield* runResearch(job)).toEqual(first);
        expect(vi.mocked(planActions)).toHaveBeenCalledWith(expect.objectContaining({ principal: expect.objectContaining({ id: agent.principal.id }) }), { meeting_id: null, request: 'Email the notes' });

        vi.mocked(planActions).mockReturnValue(Effect.fail(new Unavailable({ message: 'planner rate limited', retryable: true, retry_after_ms: 4_000 })));
        expect(yield* runResearch(job)).toEqual({ status: 'paused', resume_after_ms: 4_000, reason: 'planner rate limited' });
        vi.mocked(planActions).mockReturnValue(Effect.fail(new Unavailable({ message: 'no planner configured', retryable: false })));
        expect(yield* Effect.flip(runResearch(job))).toMatchObject({ _tag: 'JobFailure', retryable: false, message: 'no planner configured' });
      }),
      { migrated: true },
    ));
});
