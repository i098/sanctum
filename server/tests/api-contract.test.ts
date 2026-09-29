import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { createClient, pages, SanctumError } from '@sanctum/sdk';
import * as Contracts from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { contextWorkflow } from '../../sdk/examples/typescript/context-workflow.ts';
import { loadReview } from '../../web-app/src/pages/listen/review-data.ts';
import { operations, outputs } from '../../scripts/generate-sdks.ts';
import { openApiDocument } from '../src/api.ts';
import { HOLD_SOURCE_ID } from './support/fake-domain.ts';
import { fixtureAccess } from './support/fixtures.ts';
import { fixtureServer } from './support/fixture-server.ts';
import { serveFake } from './support/serve.ts';

const root = new URL('../../', import.meta.url);
const byId = new Map(operations.map(op => [op.id, op]));
const ERROR_STATUSES = ['401', '403', '404', '409', '503'];

describe('v1 OpenAPI contract', () => {
  it('matches the committed OpenAPI document and generated SDK files', () => {
    for (const [file, text] of outputs()) expect(readFileSync(new URL(file, root), 'utf8'), file).toBe(text);
  });

  it('names every operation group.endpoint and documents the error envelope on authenticated routes', () => {
    expect(new Set(operations.map(op => op.id)).size).toBe(operations.length);
    for (const [path, methods] of Object.entries(openApiDocument.paths)) {
      for (const op of Object.values(methods as Record<string, { operationId: string; responses: Record<string, unknown> }>)) {
        expect(op.operationId).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
        if (path.startsWith('/api/v1/') && op.operationId !== 'session.getSession') {
          expect(Object.keys(op.responses), op.operationId).toEqual(expect.arrayContaining(ERROR_STATUSES));
        }
      }
    }
    const envelope = openApiDocument.components.schemas['RevisionConflict'] as { required: ReadonlyArray<string> };
    expect(envelope.required).toEqual(expect.arrayContaining(['code', 'message', 'retryable', 'current_revision']));
  });

  it('pages every list with an opaque cursor and a bounded limit', () => {
    const lists = operations.filter(op => op.output.properties?.['items'] !== undefined && op.output.properties['next_cursor'] !== undefined);
    expect(lists.map(op => op.id).sort()).toEqual([
      'agents.listAgents', 'context.getContextChanges', 'context.searchContext', 'meetings.getTranscript', 'meetings.listMeetings',
    ]);
    for (const op of lists) expect(op.queryParams, op.id).toEqual(expect.arrayContaining(['cursor', 'limit']));
    expect(Schema.decodeUnknownEither(Contracts.PageLimit)(201)._tag).toBe('Left');
  });

  it('requires an idempotency key on every retried write that creates or revises', () => {
    for (const id of ['context.addContextItem', 'context.reviseContextItem', 'actions.requestAction']) {
      expect(byId.get(id)?.input.required, id).toContain('idempotency_key');
    }
  });

  it('decodes every shared SDK wire-case response with the contract schemas', () => {
    const fixture = JSON.parse(readFileSync(new URL('sdk/fixtures/wire-cases.json', root), 'utf8'));
    const errors = [Contracts.RevisionConflict, Contracts.NotFound, Contracts.Unavailable, Contracts.HashConflict];
    const success: Record<string, Schema.Schema.Any> = {
      'context.getContext': Contracts.ContextSnapshot,
      'actions.requestAction': Contracts.RequestActionOutput,
      'agents.revokeCredential': Contracts.AgentCredential,
      'meetings.listMeetings': Schema.Struct({ items: Schema.Array(Contracts.Meeting), next_cursor: Schema.NullOr(Contracts.Cursor) }),
    };
    for (const wireCase of fixture.cases) {
      expect(byId.has(wireCase.operation), wireCase.operation).toBe(true);
      for (const { response } of wireCase.exchanges) {
        const schema = response.status < 300 ? success[wireCase.operation] : Schema.Union(...errors);
        expect(schema, wireCase.name).toBeDefined();
        expect(Schema.decodeUnknownEither(schema as Schema.Schema<unknown, unknown>)(response.body)._tag, wireCase.name).toBe('Right');
      }
    }
  });
});

describe('database-free fixture API for the Python SDK job', () => {
  it.scoped('serves the fake domain, refuses readiness, and requires its token', () =>
    Effect.gen(function* () {
      const { url, token, meeting_id } = yield* fixtureServer;
      const client = createClient({ baseUrl: url, token, maxAttempts: 1 });
      expect(yield* Effect.promise(() => client.meetings.getMeeting({ meeting_id }))).toMatchObject({ id: meeting_id, title: 'Fixture planning meeting' });
      expect(yield* Effect.promise(() => client.health.readyz({}).catch(e => e))).toMatchObject({ status: 503, code: 'unavailable' });
      const anonymous = createClient({ baseUrl: url, maxAttempts: 1 });
      expect(yield* Effect.promise(() => anonymous.meetings.getMeeting({ meeting_id }).catch(e => e))).toMatchObject({ status: 401 });
    }),
  );
});

describe('TypeScript SDK against the running server', () => {
  it.scoped('serves the public OpenAPI document', () =>
    Effect.gen(function* () {
      const { url } = yield* serveFake();
      const document = yield* Effect.promise(() => fetch(`${url}/api/v1/openapi.json`).then(r => r.json()));
      expect(document).toEqual(JSON.parse(JSON.stringify(openApiDocument)));
    }),
  );

  it.scoped('runs the complete example: cite, append, conflict, changes, action receipt, revoke', () =>
    Effect.gen(function* () {
      const { url, domain } = yield* serveFake();
      const owner = fixtureAccess({ role: 'owner' });
      const meeting = domain.addMeeting(owner, 'Pilot review');
      domain.addSegment(owner, 'We chose option B for the pilot.');
      const connect = (token: string) => createClient({ baseUrl: url, token });
      const runId = randomUUID();
      const workflow = { admin: connect(domain.token(owner)), connect, meetingId: meeting.id, runId };
      const result = yield* Effect.promise(() => contextWorkflow(workflow));
      expect(result).toEqual({
        meeting: 'Pilot review',
        cited: 'We chose option B for the pilot.',
        added_id: expect.any(String),
        retry_returned_same_item: true,
        rebased_revision: 1,
        changes: ['item_added', 'item_added'],
        action_state: 'queued',
        agent_saw_revision: 2,
        after_revoke: 'unauthenticated',
      });
      // A rerun with the same run ID repeats no write: the stale write conflicts again and nothing new is appended.
      yield* Effect.promise(() => contextWorkflow(workflow).catch((error: unknown) => error));
      const snapshot = yield* Effect.promise(() => workflow.admin.context.getContext({ meeting_id: meeting.id }));
      expect(snapshot.items.map(item => item.text)).toEqual(['Cited: We chose option B for the pilot.', 'Rebased follow-up']);
    }),
  );

  it.scoped('pages search results, replays changes from any cursor, and settles receipts', () =>
    Effect.gen(function* () {
      const { url, domain } = yield* serveFake();
      const owner = fixtureAccess({ role: 'owner' });
      const meeting = domain.addMeeting(owner, 'Paging');
      const client = createClient({ baseUrl: url, token: domain.token(owner) });
      yield* Effect.promise(async () => {
        for (let revision = 0; revision < 5; revision++) {
          await client.context.addContextItem({
            meeting_id: meeting.id,
            expected_revision: revision,
            kind: 'decision',
            text: `budget decision ${revision}`,
            sources: [{ artifact_id: randomUUID() }],
            idempotency_key: `page-${revision}`,
          });
        }
      });
      const seen: string[] = [];
      yield* Effect.promise(async () => {
        for await (const page of pages(client, 'context.searchContext', { q: 'budget', limit: 2 })) seen.push(...page.items.map(i => i.text));
      });
      expect(seen).toEqual([0, 1, 2, 3, 4].map(n => `budget decision ${n}`));

      const first = yield* Effect.promise(() => client.context.getContextChanges({ limit: 2 }));
      const rest = yield* Effect.promise(() => client.context.getContextChanges({ cursor: first.next_cursor! }));
      const replay = yield* Effect.promise(() => client.context.getContextChanges({ cursor: first.next_cursor! }));
      expect([...first.items, ...rest.items].map(e => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(replay).toEqual(rest);

      const requested = yield* Effect.promise(() =>
        client.actions.requestAction({ action_key: 'linear-create-issue', configuration_ref: 'cfg', version: '1.0.0', arguments: {}, meeting_id: null, idempotency_key: 'act' }),
      );
      domain.settleAction(owner, requested.action_id, 'succeeded', { issue: 'LIN-1' });
      const receipt = yield* Effect.promise(() => client.actions.getAction({ action_id: requested.action_id }));
      expect(receipt).toMatchObject({ state: 'succeeded', provider_receipt: { issue: 'LIN-1' }, attempts: 1 });
      const reused = yield* Effect.promise(() =>
        client.actions.requestAction({ action_key: 'linear-create-issue', configuration_ref: 'cfg', version: '1.0.0', arguments: { x: 1 }, meeting_id: null, idempotency_key: 'act' }).catch(e => e),
      );
      expect(reused).toMatchObject({ status: 409, code: 'hash_conflict' });
    }),
  );

  it.scoped('gives the website review the same revision and items the SDK wrote', () =>
    Effect.gen(function* () {
      const { url, domain } = yield* serveFake();
      const owner = fixtureAccess();
      const meeting = domain.addMeeting(owner, 'Review');
      const segment = domain.addSegment(owner, 'Decision: ship B.');
      const client = createClient({ baseUrl: url, token: domain.token(owner) });
      const added = yield* Effect.promise(() =>
        client.context.addContextItem({ meeting_id: meeting.id, expected_revision: 0, kind: 'decision', text: 'Ship B', sources: [{ segment_id: segment.id, start_ms: 0, end_ms: 800 }], idempotency_key: 'ui-1' }),
      );
      const review = yield* Effect.promise(() => loadReview(client, meeting.id));
      expect(review.context).toMatchObject({ status: 'ok', data: { revision: 1, items: [added] } });
      expect(review.notes).toMatchObject({ status: 'ok', data: { decision: [added] } });
      expect(review.transcript).toMatchObject({ status: 'ok', data: { items: [{ id: segment.id }] } });
      expect(review.recording).toMatchObject({ status: 'ok', data: { meeting_id: meeting.id } });
      expect(review.activity).toMatchObject({ status: 'ok', data: { items: [{ change: 'item_added', item: { id: added.id } }] } });
      expect(review.memory).toEqual({ status: 'ok', data: [] });
    }),
  );

  it.scoped('cancels the server-side handler when the SDK call is aborted', () =>
    Effect.gen(function* () {
      const { url, domain } = yield* serveFake();
      const client = createClient({ baseUrl: url, token: domain.token(fixtureAccess()) });
      const controller = new AbortController();
      const pending = client.context.getSource({ source_id: HOLD_SOURCE_ID }, { signal: controller.signal }).catch(e => e);
      yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 300)));
      controller.abort();
      expect(yield* Effect.promise(() => pending)).toMatchObject({ name: 'AbortError' });
      yield* Effect.promise(() => expect.poll(() => domain.interrupted).toEqual([HOLD_SOURCE_ID]));
    }),
  );

  it.scoped('hides other workspaces and refuses missing scopes with the shared envelope', () =>
    Effect.gen(function* () {
      const { url, domain } = yield* serveFake();
      const alice = fixtureAccess();
      const reader = fixtureAccess({ scopes: ['context:read'] });
      const meeting = domain.addMeeting(alice, 'Private');
      const call = (access: typeof alice) => createClient({ baseUrl: url, token: domain.token(access) });
      const hidden = yield* Effect.promise(() => call(reader).meetings.getMeeting({ meeting_id: meeting.id }).catch(e => e));
      expect(hidden).toBeInstanceOf(SanctumError);
      expect(hidden).toMatchObject({ status: 404, code: 'not_found' });
      const denied = yield* Effect.promise(() => call(reader).agents.listAgents({}).catch(e => e));
      expect(denied).toMatchObject({ status: 403, code: 'forbidden', body: { required_scope: 'workspace:admin' } });
    }),
  );
});
