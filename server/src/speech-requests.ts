/** Process-bound reply and work services for direct spoken requests on a listener. */
import { SqlClient } from '@effect/sql';
import { type AccessScope, type ListenerId, Unavailable } from '@sanctum/contracts';
import { Effect, Layer, Option, Schema, Stream } from 'effect';
import { activeActionGrants } from './actions.ts';
import { requireScope, resolveAccess } from './auth.ts';
import { serverConfig } from './config.ts';
import { getContextSnapshot } from './context.ts';
import { enqueueJob } from './jobs.ts';
import { ownedListener } from './listeners.ts';
import { LlmClient } from './llm.ts';
import { listenerMeeting } from './meeting-store.ts';
import { respondToRequest } from './planner.ts';
import { SpeechReplies, SpeechWorkRequests, type SpeechWindow } from './media/speech-gate.ts';

const unavailable = (message: string) => new Unavailable({ message, retryable: false });

/** Captures the process's database and model client, so replies can run in the speech gate's own fiber. */
export const SpeechRepliesLive = Layer.effect(
  SpeechReplies,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const llm = yield* Effect.serviceOption(LlmClient);
    return (access: AccessScope, listener_id: ListenerId) => (request: string): Stream.Stream<string, Unavailable> =>
      Option.isNone(llm)
        ? Stream.fail(unavailable('No voice model is configured'))
        : Stream.unwrap(
            Effect.gen(function* () {
              const meeting = yield* listenerMeeting(access.workspace_id, listener_id);
              if (Option.isNone(meeting)) return yield* unavailable('No open meeting on this listener');
              const context = yield* getContextSnapshot(access, meeting.value);
              return respondToRequest({ request, context });
            }).pipe(
              Effect.mapError(error => (error instanceof Unavailable ? error : unavailable(`Reply context unavailable: ${error._tag}`))),
            ),
          ).pipe(Stream.provideService(SqlClient.SqlClient, sql), Stream.provideService(LlmClient, llm.value));
  }),
);

const WorkIntent = Schema.Struct({ work: Schema.Boolean });
const SYSTEM = `Decide whether this direct spoken request asks Sanctum to do background work, rather than only answer or acknowledge.
Work includes looking something up, preparing something, sending, scheduling, or following up.
Return work as a boolean. For an answer or acknowledgement, return work false.`;

/** Captures database, model and configuration for the speech controller's independent work fiber. */
export const SpeechWorkRequestsLive = Layer.effect(
  SpeechWorkRequests,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const llm = yield* LlmClient;
    const config = yield* serverConfig;
    const plannerConfigured = config.modelRoles.planner.provider === 'anthropic'
      ? Option.isSome(config.modelKeys.anthropic) : Option.isSome(config.workersAi);
    const unavailable = !plannerConfigured ? 'Planner model key is missing'
      : Option.isNone(config.pipedream.credentials) ? 'Pipedream is not configured' : null;
    return (access: AccessScope, listener_id: ListenerId) => (request: string, window: SpeechWindow) =>
      Effect.gen(function* () {
        if (unavailable) return yield* Effect.logInfo('Spoken research skipped', unavailable);
        const refreshAccess = resolveAccess({ workspace_id: access.workspace_id, principal_id: access.principal.id }).pipe(
          Effect.tap(current => requireScope(current, 'capture:ingest')),
        );
        const current = yield* refreshAccess;
        const meeting = yield* listenerMeeting(current.workspace_id, listener_id);
        if (Option.isNone(meeting)) return yield* Effect.logInfo('Spoken research skipped', 'No current meeting');
        if ((yield* activeActionGrants(current)).length === 0) {
          return yield* Effect.logInfo('Spoken research skipped', 'No active integration grant for listener owner');
        }
        const { value } = yield* llm.generate('planner', { name: 'spoken_work_intent', output: WorkIntent, system: SYSTEM, prompt: request });
        if (!value.work) return;
        const work_key = `spoken:${listener_id}:${window.epoch_id}:${window.request_id}`;
        // Lock before consistent reads so waiters see authorization changes and work committed by the prior lock holder.
        // Check completed rows too: enqueueJob otherwise re-arms active work.
        yield* sql.withTransaction(Effect.gen(function* () {
          yield* ownedListener(current, listener_id, true);
          const latest = yield* refreshAccess;
          if ((yield* activeActionGrants(latest)).length === 0) {
            return yield* Effect.logInfo('Spoken research skipped', 'No active integration grant for listener owner');
          }
          const existing = yield* sql`SELECT id FROM jobs WHERE workspace_id = ${latest.workspace_id}
            AND kind = 'research.run' AND work_key = ${work_key} LIMIT 1`;
          if (existing.length > 0) return;
          yield* enqueueJob({ workspace_id: latest.workspace_id, kind: 'research.run', work_key,
            payload: { meeting_id: meeting.value, request }, requested_by: latest.principal.id });
        }));
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchAll(error => Effect.logWarning('Spoken research skipped', error)),
      );
  }),
);
