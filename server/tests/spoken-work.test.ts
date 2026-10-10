import { describe, expect, it } from '@effect/vitest';
import { SqlClient } from '@effect/sql';
import { type AccessScope, ListenerId } from '@sanctum/contracts';
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Logger, Stream, TestClock } from 'effect';
import { createActionGrant } from '../src/actions.ts';
import { engineeringDefaults } from '../src/config.ts';
import { fixtureLlm, LlmClient } from '../src/llm.ts';
import { makeSpeechGate, SpeechGate, speechController, SpeechWorkRequests } from '../src/media/speech-gate.ts';
import { SpeechWorkRequestsLive } from '../src/speech-requests.ts';
import { SpeechSynthesizer } from '../src/providers/speech.ts';
import { setMembership } from '../src/store.ts';
import { seedAccount, seedMeeting } from './support/actions.ts';
import { seedEpoch, seedListener, speak } from './support/capture.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

const configured: Record<string, string> = {
  ANTHROPIC_API_KEY: 'synthetic-key', PIPEDREAM_PROJECT_ID: 'synthetic-project',
  PIPEDREAM_CLIENT_ID: 'synthetic-client', PIPEDREAM_CLIENT_SECRET: 'synthetic-secret',
};

const scenario = (text: string, answer: { work: boolean }, options: {
  meeting?: boolean; env?: Record<string, string>; grant?: boolean; revokeDuringClassification?: boolean;
  removeMembershipDuringClassification?: boolean;
} = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [member, other] = yield* seedWorkspace('Spoken work', ['owner', 'member']);
    const access = { ...member!, scopes: [...member!.scopes, 'capture:ingest' as const] };
    const listener = yield* seedListener(access);
    const listener_id = ListenerId.make(listener.listener_id);
    const epoch_id = yield* seedEpoch(listener);
    const meeting_id = options.meeting === false ? null : yield* seedMeeting(access.workspace_id, [access]);
    if (meeting_id) yield* sql`UPDATE meetings SET listener_id = ${listener_id} WHERE id = ${meeting_id}`;
    const account = yield* seedAccount(access);
    const grant = options.grant === false ? null : yield* createActionGrant(access, {
      grantee: access.principal.id, action_key: 'gmail-send-email', account_id: account,
      meeting_id: null, restrictions: {}, expires_at: null,
    });
    const segment = yield* speak(listener, epoch_id, 0, 2, text);
    const requests: NonNullable<Parameters<typeof fixtureLlm>[1]> = [];
    const llm = yield* Effect.provide(LlmClient, fixtureLlm(
      Array.from({ length: 4 }, () => JSON.stringify(answer)), requests));
    const service = yield* Effect.provide(SpeechWorkRequests, SpeechWorkRequestsLive.pipe(
      Layer.provide(Layer.succeed(LlmClient, LlmClient.of({
        ...llm,
        generate: (role, input) => llm.generate(role, input).pipe(Effect.tap(() => Effect.gen(function* () {
          if (options.revokeDuringClassification) {
            yield* sql`UPDATE action_grants SET revoked_at = UTC_TIMESTAMP(6) WHERE id = ${grant!.id}`.pipe(Effect.orDie);
          }
          if (options.removeMembershipDuringClassification) {
            yield* setMembership('fixture-issuer', access.workspace_id, access.principal.id, access.role).pipe(
              Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie);
            yield* setMembership('fixture-issuer', access.workspace_id, access.principal.id, null).pipe(
              Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie);
          }
        }))),
      }))),
      Layer.provide(Layer.setConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(options.env ?? configured))))),
    ));
    const finished = yield* Deferred.make<void>();
    const replies: string[] = [];
    const controller = yield* speechController({ listener_id, sample_rate: 16_000, send: () => Effect.void,
      respond: request => (replies.push(request), Stream.empty),
      requestWork: (request, window) => service(access, listener_id)(request, window).pipe(Effect.ensuring(Deferred.succeed(finished, undefined))),
    }).pipe(Effect.provideService(SpeechGate, makeSpeechGate()),
      Effect.provideService(SpeechSynthesizer, SpeechSynthesizer.of({ synthesize: () => Stream.empty })));
    const jobs = sql<{ payload: unknown; requested_by: string; work_key: string; rearmed: number }>`SELECT payload, requested_by, work_key, rearmed
      FROM jobs WHERE workspace_id = ${access.workspace_id} AND kind = 'research.run'`;
    const complete = Effect.gen(function* () {
      yield* controller.onSegment(segment);
      yield* TestClock.adjust(engineeringDefaults.speech.turnWaitMs);
      yield* Deferred.await(finished);
    });
    return { controller, finished, segment, requests, replies, jobs, access, other: other!, account, grant, listener_id, epoch_id, meeting_id, service, complete };
  });

const holdListener = (access: AccessScope, listener_id: ListenerId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const acquired = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* Effect.forkScoped(sql.withTransaction(Effect.gen(function* () {
      yield* sql`SELECT id FROM listeners WHERE workspace_id = ${access.workspace_id} AND id = ${listener_id} FOR UPDATE`;
      yield* Deferred.succeed(acquired, undefined);
      yield* Deferred.await(release);
    })));
    yield* Deferred.await(acquired);
    return Effect.zipRight(Deferred.succeed(release, undefined), Fiber.join(holder));
  });

const waitForListenerLocks = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.promise(() => expect.poll(async () => {
      const [row] = await Effect.runPromise(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t
        JOIN information_schema.PROCESSLIST p ON p.ID = t.trx_mysql_thread_id
        WHERE p.DB = DATABASE() AND t.trx_state = 'LOCK WAIT' AND p.INFO LIKE '%FROM listeners%'`);
      return Number(row!.n);
    }, { timeout: 5_000, interval: 200 }).toBe(count));
  });


describe('spoken work', () => {
  it.effect('enqueues model-selected work for the current meeting and listener owner, without changing the reply', () =>
    withDatabase(Effect.gen(function* () {
      const test = yield* scenario('Sanctum, could you look up the train times?', { work: true });
      yield* test.complete;
      const rows = yield* test.jobs;
      expect(rows).toHaveLength(1);
      const payload = rows[0]!.payload;
      expect(typeof payload === 'string' ? JSON.parse(payload) : payload).toEqual({ meeting_id: test.meeting_id, request: 'could you look up the train times?' });
      expect(rows[0]).toMatchObject({ requested_by: test.access.principal.id,
        work_key: `spoken:${test.listener_id}:${test.epoch_id}:${test.segment.id}`, rearmed: 0 });
      expect(test.replies).toEqual(['could you look up the train times?']);
      expect(test.requests).toHaveLength(1);
      yield* test.controller.onEnd('disconnect');
    }), { migrated: true }));

  it.effect('does not enqueue an answer-only direct request', () =>
    withDatabase(Effect.gen(function* () {
      const test = yield* scenario('Sanctum, what time is it', { work: false });
      yield* test.complete;
      expect(yield* test.jobs).toEqual([]);
      expect(test.replies).toEqual(['what time is it']);
      yield* test.controller.onEnd('disconnect');
    }), { migrated: true }));

  it.effect('ignores duplicate finals before and after the reply and deduplicates retries after job completion', () =>
    withDatabase(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const test = yield* scenario('Sanctum, prepare the follow-up', { work: true });
      yield* test.controller.onSegment(test.segment);
      yield* test.controller.onSegment(test.segment);
      yield* TestClock.adjust(engineeringDefaults.speech.turnWaitMs);
      yield* Deferred.await(test.finished);
      yield* test.controller.onSegment(test.segment);
      yield* TestClock.adjust(engineeringDefaults.speech.turnWaitMs);
      expect(test.replies).toEqual(['prepare the follow-up']);
      expect(test.requests).toHaveLength(1);
      const window = { listener_id: test.listener_id, epoch_id: test.epoch_id, request_id: test.segment.id,
        generation: 1, sample_end: test.segment.source.sample_end, expires_at: Date.now() + 30_000 };
      const retry = test.service(test.access, test.listener_id)('prepare the follow-up', window);
      yield* Effect.all([retry, retry], { concurrency: 2 });
      expect((yield* test.jobs)).toHaveLength(1);
      expect((yield* test.jobs)[0]!.rearmed).toBe(0);
      yield* sql`UPDATE jobs SET status = 'succeeded' WHERE workspace_id = ${test.access.workspace_id} AND kind = 'research.run'`;
      yield* retry;
      expect((yield* test.jobs)).toHaveLength(1);
      yield* test.controller.onEnd('disconnect');
    }), { migrated: true }));

  for (const [name, options, reason] of [
    ['no research key', { env: Object.fromEntries(Object.entries(configured).filter(([key]) => key !== 'ANTHROPIC_API_KEY')) }, 'Anthropic research key is missing'],
    ['no planner key', { env: { ...configured, PLANNER_MODEL_PROVIDER: 'workers-ai' } }, 'Planner model key is missing'],
    ['no Pipedream', { env: { ANTHROPIC_API_KEY: 'synthetic-key' } }, 'Pipedream is not configured'],
    ['no meeting', { meeting: false }, 'No current meeting'],
    ['no grant', { grant: false }, 'No active integration grant for listener owner'],
  ] as const) {
    it.effect(`logs the reason and enqueues nothing with ${name}`, () => {
      const messages: unknown[] = [];
      return withDatabase(Effect.gen(function* () {
        const test = yield* scenario('Sanctum, send the notes', { work: true }, options);
        yield* test.complete;
        expect(yield* test.jobs).toEqual([]);
        expect(test.requests).toEqual([]);
        expect(messages).toEqual([['Spoken research skipped', reason]]);
        expect(test.replies).toEqual(['send the notes']);
        yield* test.controller.onEnd('disconnect');
      }), { migrated: true }).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, Logger.make(({ message }) => { messages.push(message); }))));
    });
  }

  for (const invalid of ['revoked', 'expired', 'disconnected', 'other principal', 'other workspace'] as const) {
    it.effect(`does not classify or enqueue with a grant that is ${invalid}`, () =>
      withDatabase(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const test = yield* scenario('Sanctum, send the notes', { work: true },
          { grant: invalid !== 'other workspace' });
        if (invalid === 'revoked') yield* sql`UPDATE action_grants SET revoked_at = UTC_TIMESTAMP(6) WHERE id = ${test.grant!.id}`;
        if (invalid === 'expired') yield* sql`UPDATE action_grants SET expires_at = UTC_TIMESTAMP(6) WHERE id = ${test.grant!.id}`;
        if (invalid === 'disconnected') yield* sql`UPDATE integration_accounts SET status = 'disconnected' WHERE id = ${test.account}`;
        if (invalid === 'other principal') yield* sql`UPDATE action_grants SET grantee_principal_id = ${test.other.principal.id} WHERE id = ${test.grant!.id}`;
        if (invalid === 'other workspace') {
          const [foreign] = yield* seedWorkspace('Foreign grant');
          yield* sql`INSERT INTO workspace_members (workspace_id, principal_id, role, created_at)
            VALUES (${foreign!.workspace_id}, ${test.access.principal.id}, 'member', UTC_TIMESTAMP(6))`;
          const owner = { ...test.access, workspace_id: foreign!.workspace_id };
          yield* createActionGrant(owner, {
            grantee: owner.principal.id, action_key: 'gmail-send-email', account_id: yield* seedAccount(owner),
            meeting_id: null, restrictions: {}, expires_at: null,
          });
        }
        yield* test.complete;
        expect(test.requests).toEqual([]);
        expect(yield* test.jobs).toEqual([]);
        expect(test.replies).toEqual(['send the notes']);
        yield* test.controller.onEnd('disconnect');
      }), { migrated: true }));
  }

  it.effect('does not enqueue if the grant is revoked during classification', () =>
    withDatabase(Effect.gen(function* () {
      const test = yield* scenario('Sanctum, send the notes', { work: true },
        { revokeDuringClassification: true });
      yield* test.complete;
      expect(test.requests).toHaveLength(1);
      expect(yield* test.jobs).toEqual([]);
      expect(test.replies).toEqual(['send the notes']);
      yield* test.controller.onEnd('disconnect');
    }), { migrated: true }));

  it.effect('does not classify or enqueue after membership removal on an existing listener connection', () =>
    withDatabase(Effect.gen(function* () {
      const test = yield* scenario('Sanctum, send the notes', { work: true });
      yield* setMembership('fixture-issuer', test.access.workspace_id, test.access.principal.id, test.access.role);
      yield* setMembership('fixture-issuer', test.access.workspace_id, test.access.principal.id, null);
      yield* test.complete;
      expect(test.requests).toEqual([]);
      expect(yield* test.jobs).toEqual([]);
      yield* test.controller.onEnd('disconnect');
    }), { migrated: true }));

  it.effect('does not enqueue if membership is removed during classification', () =>
    withDatabase(Effect.gen(function* () {
      const test = yield* scenario('Sanctum, send the notes', { work: true },
        { removeMembershipDuringClassification: true });
      yield* test.complete;
      expect(test.requests).toHaveLength(1);
      expect(yield* test.jobs).toEqual([]);
      yield* test.controller.onEnd('disconnect');
    }), { migrated: true }));

  it.live('keeps the first accepted request when first-time retries wait for the listener lock', () =>
    withDatabase(Effect.scoped(Effect.gen(function* () {
      const test = yield* scenario('Sanctum, send the meeting notes', { work: true });
      const release = yield* holdListener(test.access, test.listener_id);
      yield* Effect.gen(function* () {
        const window = { listener_id: test.listener_id, epoch_id: test.epoch_id, request_id: test.segment.id,
          generation: 1, sample_end: test.segment.source.sample_end, expires_at: Date.now() + 30_000 };
        const first = yield* Effect.forkScoped(test.service(test.access, test.listener_id)('send the meeting notes', window));
        yield* waitForListenerLocks(1);
        const second = yield* Effect.forkScoped(test.service(test.access, test.listener_id)('send the notes', window));
        yield* waitForListenerLocks(2);
        yield* release;
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        const rows = yield* test.jobs;
        expect(rows).toHaveLength(1);
        const payload = rows[0]!.payload;
        expect(typeof payload === 'string' ? JSON.parse(payload) : payload).toEqual({
          meeting_id: test.meeting_id, request: 'send the meeting notes',
        });
        expect(rows[0]!.rearmed).toBe(0);
        yield* test.controller.onEnd('disconnect');
      }).pipe(Effect.ensuring(release.pipe(Effect.orDie)));
    })), { migrated: true }));

  for (const change of ['membership removed', 'grant revoked', 'grant expired', 'account disconnected'] as const) {
    it.live(`does not enqueue when ${change} while waiting for the listener lock`, () =>
      withDatabase(Effect.scoped(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const test = yield* scenario('Sanctum, send the notes', { work: true });
        if (change === 'membership removed') {
          yield* setMembership('fixture-issuer', test.access.workspace_id, test.access.principal.id, test.access.role);
        }
        const release = yield* holdListener(test.access, test.listener_id);
        yield* Effect.gen(function* () {
          const window = { listener_id: test.listener_id, epoch_id: test.epoch_id, request_id: test.segment.id,
            generation: 1, sample_end: test.segment.source.sample_end, expires_at: Date.now() + 30_000 };
          const pending = yield* Effect.forkScoped(test.service(test.access, test.listener_id)('send the notes', window));
          yield* waitForListenerLocks(1);
          if (change === 'membership removed') yield* setMembership('fixture-issuer', test.access.workspace_id, test.access.principal.id, null);
          if (change === 'grant revoked') yield* sql`UPDATE action_grants SET revoked_at = UTC_TIMESTAMP(6) WHERE id = ${test.grant!.id}`;
          if (change === 'grant expired') yield* sql`UPDATE action_grants SET expires_at = UTC_TIMESTAMP(6) WHERE id = ${test.grant!.id}`;
          if (change === 'account disconnected') yield* sql`UPDATE integration_accounts SET status = 'disconnected' WHERE id = ${test.account}`;
          yield* release;
          yield* Fiber.join(pending);
          expect(test.requests).toHaveLength(1);
          expect(yield* test.jobs).toEqual([]);
          yield* test.controller.onEnd('disconnect');
        }).pipe(Effect.ensuring(release.pipe(Effect.orDie)));
      })), { migrated: true }));
  }
});
