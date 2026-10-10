import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, type ActionId, ActionReceipt, type IntegrationAccountId, type ListenerId, type MeetingId } from '@sanctum/contracts';
import { Effect, Fiber, Schedule, Schema, TestClock } from 'effect';
import { beforeEach, vi } from 'vitest';
import { createActionGrant, getActionReceipt, listenerFeed, listMeetingActions, requestAction, resolveAction, revokeActionGrant } from '../src/actions.ts';
import { engineeringDefaults } from '../src/config.ts';
import { executeAction } from '../src/executor.ts';
import { runWorker } from '../src/job-runner.ts';
import { withDatabase } from './support/database.ts';
import { actionRow, actionServices, provider, queuedJob, seedAccount, seedCredential, seedMeeting } from './support/actions.ts';
import { seedWorkspace } from './support/fixtures.ts';

vi.mock('../src/integrations.ts', async importOriginal => {
  const { fakeIntegrations } = await import('./support/actions.ts');
  return fakeIntegrations(importOriginal as never);
});

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
    yield* seedCredential(owner!, agent!);
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

/** A receipt as a client decodes it from the JSON response body. */
const overWire = (receipt: ActionReceipt) => Schema.decodeUnknownSync(ActionReceipt)(JSON.parse(JSON.stringify(Schema.encodeSync(ActionReceipt)(receipt))));

const execute = (access: AccessScope, action_id: ActionId) =>
  Effect.flatMap(queuedJob(access.workspace_id, 'action.execute', action_id), executeAction).pipe(Effect.provide(actionServices));

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

  it.effect('keeps an over-budget provider result as an artifact the receipt references', () =>
    withDatabase(
      Effect.gen(function* () {
        const { agent } = yield* setup();
        provider.mode = 'large_result';
        const queued = yield* requestAction(agent, request());
        yield* execute(agent, queued.action_id);
        const receipt = yield* getActionReceipt(agent, queued.action_id);
        const artifact_id = receipt.provider_receipt?.['artifact_id'];
        expect(artifact_id).toEqual(expect.any(String));
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ kind: string; content: string; provenance: unknown }>`SELECT kind, content, provenance FROM artifacts WHERE id = ${String(artifact_id)}`;
        expect(row).toMatchObject({ kind: 'action_output', provenance: { action_id: queued.action_id, attempt: 1 } });
        expect(JSON.parse(row!.content)).toEqual({ rows: ['é'.repeat(20_000)] });
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

  it.effect('lists one meeting\'s receipts oldest first, only to their requester and admins, in offset pages', () =>
    withDatabase(
      Effect.gen(function* () {
        const { owner, member, agent } = yield* setup();
        const meeting_id = yield* seedMeeting(agent.workspace_id, [agent, member, owner]);
        const other = yield* seedMeeting(agent.workspace_id, [agent]);
        const ids: Array<ActionId> = [];
        for (const key of ['a', 'b', 'c']) ids.push((yield* requestAction(agent, request({ meeting_id, idempotency_key: key, ...(key === 'b' ? { title: 'Email the notes to Maria' } : {}) }))).action_id);
        yield* requestAction(agent, request({ meeting_id: other, idempotency_key: 'elsewhere' }));
        const first = yield* listMeetingActions(agent, meeting_id, { limit: 2 });
        expect(first.actions.map(action => action.action_id)).toEqual(ids.slice(0, 2));
        const rest = yield* listMeetingActions(agent, meeting_id, { cursor: first.next_cursor!, limit: 2 });
        expect(rest).toEqual({ actions: [expect.objectContaining({ action_id: ids[2], meeting_id, state: 'queued' })], next_cursor: null });
        expect((yield* listMeetingActions(owner, meeting_id, {})).actions.map(action => action.action_id)).toEqual(ids);
        expect(yield* listMeetingActions(member, meeting_id, {})).toEqual({ actions: [], next_cursor: null });
        expect(yield* Effect.flip(listMeetingActions(member, other, {}))).toMatchObject({ _tag: 'NotFound' });
        expect(yield* Effect.flip(listMeetingActions(agent, meeting_id, { cursor: 'bogus' }))).toMatchObject({ _tag: 'NotFound', message: 'Unknown cursor' });
        // Feed rows carry the stored title, or a label from the key; they follow the same visibility.
        const sql = yield* SqlClient.SqlClient;
        const listener_id = randomUUID() as ListenerId;
        yield* sql`INSERT INTO listeners (id, workspace_id, principal_id, name, mode, capabilities, created_at)
          VALUES (${listener_id}, ${owner.workspace_id}, ${owner.principal.id}, 'Room', 'room', '{}', UTC_TIMESTAMP(6))`;
        yield* sql`UPDATE meetings SET listener_id = ${listener_id} WHERE id = ${meeting_id}`;
        const feed = yield* listenerFeed(owner, listener_id);
        expect(feed.meeting_id).toBe(meeting_id);
        expect(feed.actions.map(action => action.title)).toEqual(['Gmail: send email', 'Email the notes to Maria', 'Gmail: send email']);
        expect(yield* listenerFeed(member, listener_id)).toEqual({ meeting_id, actions: [] });
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

        const meetingA = yield* seedMeeting(owner.workspace_id, [owner, member]);
        const meetingB = yield* seedMeeting(owner.workspace_id, [owner, member]);
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
        // A person's word is signed and never labelled as the provider's own reconciliation.
        expect(overWire(yield* getActionReceipt(owner, queued.action_id))).toEqual(resolved);
        expect(resolved).toMatchObject({
          state: 'succeeded',
          reconciliation: 'resolved_by_human',
          resolved_by: owner.principal.id,
          resolved_at: expect.stringMatching(/Z$/),
          provider_receipt: { message_id: 'checked-in-gmail' },
        });
        expect((yield* Effect.flip(resolveAction(owner, queued.action_id, { outcome: 'failed', provider_receipt: null })))._tag).toBe('Forbidden');
      }),
      { migrated: true },
    ));

  it.effect('records unknown when the provider does not answer in time, then settles from the late answer', () =>
    withDatabase(
      Effect.gen(function* () {
        const { agent } = yield* setup();
        const realDelay = Effect.promise(() => new Promise(resolve => setTimeout(resolve, 20)));
        provider.mode = 'hold';
        const queued = yield* requestAction(agent, request());
        const attempt = yield* Effect.fork(execute(agent, queued.action_id));
        while (provider.release === null) yield* realDelay;
        yield* TestClock.adjust(`${engineeringDefaults.actionSubmitTimeoutMs} millis`);
        yield* Fiber.join(attempt);
        expect(yield* actionRow(agent.workspace_id, queued.action_id)).toMatchObject({ state: 'unknown', reconciliation: 'pending', last_error: { code: 'ambiguous' } });
        provider.release!();
        let row = yield* actionRow(agent.workspace_id, queued.action_id);
        for (let tries = 0; row.state === 'unknown' && tries < 200; tries++) row = yield* Effect.zipRight(realDelay, actionRow(agent.workspace_id, queued.action_id));
        expect(row).toMatchObject({ state: 'succeeded', reconciliation: 'reconciled', attempts: 1 });
        expect(overWire(yield* getActionReceipt(agent, queued.action_id))).toMatchObject({ reconciliation: 'reconciled', resolved_by: null, resolved_at: null, provider_receipt: { message_id: 'msg-1' } });
        expect(provider.sent).toHaveLength(1);
      }),
      { migrated: true },
    ));

  it.live('records unknown when the job ceiling cuts off a submission and never resubmits it', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { agent } = yield* setup();
        provider.mode = 'hold';
        const queued = yield* requestAction(agent, request());
        const worker = yield* Effect.fork(
          runWorker({ 'action.execute': executeAction }, { leaseMs: 3_000, pollMs: 50, concurrency: 1, ceilingMs: 300 }).pipe(Effect.provide(actionServices)),
        );
        const poll = <A>(check: Effect.Effect<A, unknown, SqlClient.SqlClient>, done: (value: A) => boolean) =>
          check.pipe(Effect.filterOrFail(done, () => 'not yet'), Effect.retry(Schedule.spaced('50 millis')), Effect.timeout('10 seconds'));
        const row = yield* poll(actionRow(agent.workspace_id, queued.action_id), current => current.state === 'unknown');
        expect(row).toMatchObject({ state: 'unknown', reconciliation: 'pending', attempts: 1, last_error: { code: 'ambiguous' } });
        // The ceiling failed the job retryably; its retry (after a 1 s backoff) finds the row settled and submits nothing.
        const jobRow = sql<{ status: string; attempts: number }>`SELECT status, attempts FROM jobs WHERE kind = 'action.execute' AND work_key = ${queued.action_id}`;
        expect(yield* poll(jobRow, ([current]) => current?.status === 'succeeded')).toEqual([{ status: 'succeeded', attempts: 2 }]);
        expect(provider.sent).toHaveLength(1);
        yield* Fiber.interrupt(worker);
        // The held answer still arrives late and reconciles the row.
        provider.release!();
        expect(yield* poll(actionRow(agent.workspace_id, queued.action_id), current => current.state !== 'unknown')).toMatchObject({ state: 'succeeded', reconciliation: 'reconciled', attempts: 1 });
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
