/**
 * Reply text for a direct spoken request on one listener: the requester's context for the
 * listener's open meeting, answered by the voice model role. Anything missing (no open meeting,
 * no context access, no model) fails `Unavailable`, so the speech gate stays silent.
 */
import { SqlClient } from '@effect/sql';
import { type AccessScope, type ListenerId, type MeetingId, Unavailable } from '@sanctum/contracts';
import { Effect, Layer, Option, Stream } from 'effect';
import { getContextSnapshot } from '../context.ts';
import { LlmClient } from '../llm.ts';
import { respondToRequest } from '../planner.ts';
import { SpeechReplies } from './speech-gate.ts';

const unavailable = (message: string) => new Unavailable({ message, retryable: false });

const openMeeting = (access: AccessScope, listener_id: ListenerId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ id: MeetingId }>`SELECT id FROM meetings WHERE workspace_id = ${access.workspace_id} AND listener_id = ${listener_id}
      AND state IN ('provisional', 'active') ORDER BY started_at DESC LIMIT 1`;
    return row ? row.id : yield* unavailable('No open meeting on this listener');
  });

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
              const meeting_id = yield* openMeeting(access, listener_id);
              const context = yield* getContextSnapshot(access, meeting_id);
              return respondToRequest({ request, context });
            }).pipe(
              Effect.mapError(error => (error instanceof Unavailable ? error : unavailable(`Reply context unavailable: ${error._tag}`))),
            ),
          ).pipe(Stream.provideService(SqlClient.SqlClient, sql), Stream.provideService(LlmClient, llm.value));
  }),
);
