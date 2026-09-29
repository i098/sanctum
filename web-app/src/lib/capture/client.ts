/** Browser client of `ListenersApi`, derived from the shared contract so paths and schemas cannot drift. */
import { FetchHttpClient, HttpApi, HttpApiClient, type HttpApiError } from '@effect/platform';
import { Forbidden, HashConflict, ListenersApi, NotFound, Unauthenticated, Unavailable } from '@sanctum/contracts';
import { Effect } from 'effect';

/** The listeners group with the API-wide error envelope `SanctumApi` serves. */
class CaptureApi extends HttpApi.make('sanctum')
    .add(ListenersApi)
    .addError(Unauthenticated)
    .addError(Forbidden)
    .addError(NotFound)
    .addError(HashConflict)
    .addError(Unavailable) {}

type ApiError = HttpApiError.HttpApiDecodeError | Unauthenticated | Forbidden | NotFound | HashConflict | Unavailable;

export type ListenersClient = HttpApiClient.Client<typeof ListenersApi, ApiError, never>['listeners'];

/** Same-origin by default, so the secure session cookie authenticates every call. */
export function makeListenersClient(baseUrl = globalThis.location?.origin ?? ''): ListenersClient {
    return Effect.runSync(HttpApiClient.make(CaptureApi, { baseUrl }).pipe(Effect.provide(FetchHttpClient.layer))).listeners;
}
