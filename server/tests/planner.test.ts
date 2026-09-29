import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { ContextSnapshot, GetIntegrationActionOutput, MeetingId, Unavailable } from '@sanctum/contracts';
import { Chunk, Effect, Schema, Stream } from 'effect';
import { fixtureLlm } from '../src/llm.ts';
import { planActions, respondToRequest } from '../src/planner.ts';
import type { ProviderRequest } from '../src/providers/types.ts';
import { fixtureAccess } from './support/fixtures.ts';

const meeting_id = MeetingId.make(randomUUID());
const field = (name: string, required: boolean) => ({ name, type: 'string', required, description: null, remote_options: false });
const inspected = (action_key: string, complete: boolean) =>
  Schema.decodeSync(GetIntegrationActionOutput)({
    action_key,
    version: '1.4.0',
    configuration_ref: `cfg-${action_key}`,
    fields: [field('to', true), field('subject', true), field('body', true), field('cc', false)],
    missing: complete ? [] : ['calendar_id'],
    options: null,
    complete,
  });
const actions = [inspected('gmail-send-email', true), inspected('google_calendar-create-event', false)];
const argument = (name: string, value: unknown) => ({ name, value_json: JSON.stringify(value) });
const email = [argument('to', ['maria@example.com']), argument('subject', 'Rollout notes'), argument('body', 'Notes attached.')];

describe('planActions', () => {
  it.effect('proposes only offered complete actions with declared arguments and code-owned meeting, configuration and key', () =>
    Effect.gen(function* () {
      const access = fixtureAccess();
      const answer = JSON.stringify({
        actions: [
          { action_key: 'gmail-send-email', arguments: email },
          { action_key: 'gmail-send-email', arguments: [...email, argument('bcc', 'x@example.com')] },
          { action_key: 'gmail-send-email', arguments: [argument('to', ['maria@example.com']), argument('body', 'hi')] },
          { action_key: 'gmail-send-email', arguments: [argument('to', 'a'), { name: 'subject', value_json: 'not json' }, argument('body', 'b')] },
        ],
      });
      const requests: ProviderRequest[] = [];
      const request = 'Email Maria the rollout notes';
      const planned = yield* Effect.provide(planActions(access, { meeting_id, request, actions }), fixtureLlm([answer], requests));
      expect(planned).toEqual([
        {
          action_key: 'gmail-send-email',
          configuration_ref: 'cfg-gmail-send-email',
          version: '1.4.0',
          arguments: { to: ['maria@example.com'], subject: 'Rollout notes', body: 'Notes attached.' },
          meeting_id,
          idempotency_key: expect.stringMatching(/^plan-[0-9a-f]{64}$/),
        },
      ]);
      expect(requests[0]).toMatchObject({ model: 'claude-sonnet-5-5', json: { name: 'action_plan' } });
      const schema = requests[0]!.json!.schema as { properties: { actions: { items: { properties: { action_key: unknown } } } } };
      expect(schema.properties.actions.items.properties.action_key).toEqual({ type: 'string', enum: ['gmail-send-email'] });
      expect(requests[0]!.prompt).not.toContain('google_calendar-create-event');

      const reordered = JSON.stringify({ actions: [{ action_key: 'gmail-send-email', arguments: [...email].reverse() }] });
      const again = yield* Effect.provide(planActions(access, { meeting_id, request, actions }), fixtureLlm([reordered]));
      expect(again[0]!.idempotency_key).toBe(planned[0]!.idempotency_key);
      const elsewhere = yield* Effect.provide(planActions(access, { meeting_id: MeetingId.make(randomUUID()), request, actions }), fixtureLlm([reordered]));
      expect(elsewhere[0]!.idempotency_key).not.toBe(planned[0]!.idempotency_key);
    }));

  it.effect('rejects a plan naming an action that was not offered', () =>
    Effect.gen(function* () {
      const answer = JSON.stringify({ actions: [{ action_key: 'slack-post-message', arguments: [] }] });
      const failure = yield* Effect.flip(Effect.provide(planActions(fixtureAccess(), { meeting_id, request: 'Post it', actions }), fixtureLlm([answer])));
      expect(failure).toMatchObject({ _tag: 'Unavailable', retryable: false, message: expect.stringMatching(/failed the action_plan schema/) });
    }));

  it.effect('checks scope and meeting access before calling the model, and plans nothing without inspected actions', () =>
    Effect.gen(function* () {
      const requests: ProviderRequest[] = [];
      const llm = fixtureLlm([], requests);
      const reader = fixtureAccess({ scopes: ['context:read'] });
      expect(yield* Effect.flip(Effect.provide(planActions(reader, { meeting_id, request: 'Email Maria', actions }), llm))).toMatchObject({ _tag: 'Forbidden', required_scope: 'actions:request' });
      const narrow = fixtureAccess({ meetings: { kind: 'allowlist', meeting_ids: [MeetingId.make(randomUUID())] } });
      expect((yield* Effect.flip(Effect.provide(planActions(narrow, { meeting_id, request: 'Email Maria', actions }), llm)))._tag).toBe('Forbidden');
      expect(yield* Effect.provide(planActions(fixtureAccess(), { meeting_id, request: 'Email Maria', actions: [actions[1]!] }), llm)).toEqual([]);
      expect(yield* Effect.provide(planActions(fixtureAccess(), { meeting_id, request: 'Email Maria' }), llm)).toEqual([]);
      expect(requests).toHaveLength(0);
    }));
});

describe('respondToRequest', () => {
  const context = Schema.decodeSync(ContextSnapshot)({
    meeting_id,
    revision: 3,
    as_of: '2026-11-01T00:06:00Z',
    timezone: 'America/Los_Angeles',
    source_watermark: null,
    items: [
      { text: 'Pilot access stays with the test group.', state: 'committed' as const },
      { text: 'Pilot access is open to everyone.', state: 'superseded' as const },
    ].map(({ text, state }) => ({
      id: randomUUID(),
      revision: 1,
      meeting_id,
      kind: 'decision',
      text,
      state,
      derivation: 'spoken',
      event_at: null,
      valid_from: null,
      valid_until: null,
      time: null,
      author: { type: 'system', id: randomUUID() },
      sources: [{ segment_id: randomUUID(), start_ms: 0, end_ms: 1_000 }],
      supersedes: null,
      created_at: '2026-11-01T00:01:00Z',
    })),
    changes_cursor: 'cursor-1',
    truncated: false,
  });

  it.effect('streams the voice model reply grounded in current context', () =>
    Effect.gen(function* () {
      const requests: ProviderRequest[] = [];
      const reply = 'Pilot access stays with the test group.';
      const chunks = yield* Effect.provide(Stream.runCollect(respondToRequest({ request: 'Who gets pilot access?', context })), fixtureLlm([reply], requests));
      expect(Chunk.size(chunks)).toBeGreaterThan(1);
      expect(Chunk.join(chunks, '')).toBe(reply);
      expect(requests[0]).toMatchObject({ model: 'qwen-3.8-27b', reasoning: 'none' });
      expect(requests[0]!.prompt).toContain('- decision (committed): Pilot access stays with the test group.');
      expect(requests[0]!.prompt).not.toContain('open to everyone');
      expect(requests[0]!.json).toBeUndefined();
    }));

  it.effect('fails the stream when the voice model is unavailable', () =>
    Effect.gen(function* () {
      const down = new Unavailable({ message: 'voice model: Cerebras HTTP 503', retryable: true });
      const failure = yield* Effect.flip(Effect.provide(Stream.runDrain(respondToRequest({ request: 'Anything?', context })), fixtureLlm([down, 'late text'])));
      expect(failure).toBe(down);
    }));
});
