import { SqlClient } from '@effect/sql';
import { type AccessScope, type ListenerId } from '@sanctum/contracts';
import { Effect, Layer, Option, Schema } from 'effect';
import { activeActionGrants } from '../actions.ts';
import { serverConfig } from '../config.ts';
import { enqueueJob } from '../jobs.ts';
import { ownedListener } from '../listeners.ts';
import { LlmClient } from '../llm.ts';
import { listenerMeeting } from '../meeting-store.ts';
import { SpeechWorkRequests, type SpeechWindow } from './speech-gate.ts';

const WorkIntent = Schema.Struct({ work: Schema.Boolean, request: Schema.String });
const SYSTEM = `Decide whether this direct spoken request asks Sanctum to do background work, rather than only answer or acknowledge.
Work includes looking something up, preparing something, sending, scheduling, or following up.
Return work as a boolean and request as a short normalized request that preserves the person's intent and stated details.
Do not invent recipients, dates, permissions, or work the person did not ask for. For an answer or acknowledgement, return work false and an empty request.`;

/** Captures database, model and configuration for the speech controller's independent work fiber. */
export const SpeechWorkRequestsLive = Layer.effect(
  SpeechWorkRequests,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const llm = yield* LlmClient;
    const config = yield* serverConfig;
    const plannerConfigured = config.modelRoles.planner.provider === 'anthropic'
      ? Option.isSome(config.modelKeys.anthropic) : Option.isSome(config.workersAi);
    const unavailable = Option.isNone(config.modelKeys.anthropic) ? 'Anthropic research key is missing'
      : !plannerConfigured ? 'Planner model key is missing'
      : Option.isNone(config.pipedream.credentials) ? 'Pipedream is not configured' : null;
    return (access: AccessScope, listener_id: ListenerId) => (request: string, window: SpeechWindow) =>
      Effect.gen(function* () {
        if (unavailable) return yield* Effect.logInfo('Spoken research skipped', unavailable);
        const meeting = yield* listenerMeeting(access.workspace_id, listener_id);
        if (Option.isNone(meeting)) return yield* Effect.logInfo('Spoken research skipped', 'No current meeting');
        if ((yield* activeActionGrants(access)).length === 0) {
          return yield* Effect.logInfo('Spoken research skipped', 'No active integration grant for listener owner');
        }
        const { value } = yield* llm.generate('planner', { name: 'spoken_work_intent', output: WorkIntent, system: SYSTEM, prompt: request });
        if (!value.work) return;
        const normalized = value.request.trim();
        if (!normalized) return yield* Effect.logWarning('Spoken research skipped', 'Model returned an empty work request');
        const work_key = `spoken:${listener_id}:${window.epoch_id}:${window.request_id}`;
        // Serialize on the listener and check completed rows too: enqueueJob otherwise re-arms active work.
        yield* sql.withTransaction(Effect.gen(function* () {
          yield* ownedListener(access, listener_id, true);
          if ((yield* activeActionGrants(access)).length === 0) {
            return yield* Effect.logInfo('Spoken research skipped', 'No active integration grant for listener owner');
          }
          const existing = yield* sql`SELECT id FROM jobs WHERE workspace_id = ${access.workspace_id}
            AND kind = 'research.run' AND work_key = ${work_key} LIMIT 1`;
          if (existing.length > 0) return;
          yield* enqueueJob({ workspace_id: access.workspace_id, kind: 'research.run', work_key,
            payload: { meeting_id: meeting.value, request: normalized }, requested_by: access.principal.id });
        }));
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchAll(error => Effect.logWarning('Spoken research skipped', error)),
      );
  }),
);
