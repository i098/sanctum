/**
 * Reply text for a direct spoken request on one listener: the requester's context for the
 * listener's open meeting, answered by the voice model role. Anything missing (no open meeting,
 * no context access, no model) fails `Unavailable`, so the speech gate stays silent.
 */
import { SqlClient } from '@effect/sql';
import { type AccessScope, type ListenerId, Unavailable } from '@sanctum/contracts';
import { Effect, Layer, Option, Stream } from 'effect';
import { getContextSnapshot } from '../context.ts';
import { LlmClient } from '../llm.ts';
import { listenerMeeting } from '../meeting-store.ts';
import { respondToRequest } from '../planner.ts';
import { SpeechReplies } from './speech-gate.ts';

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
