/** Browser client of `ListenersApi`, derived from the shared contract so paths and schemas cannot drift. */
import { FetchHttpClient, HttpApi, HttpApiClient, HttpClient, HttpClientRequest, type HttpApiError } from '@effect/platform';
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

/** The session opener's script-readable double-submit cookie; its value goes back as `x-csrf-token`. */
const csrfToken = (): string | undefined =>
    globalThis.document?.cookie.split('; ').find((pair) => pair.startsWith('sanctum_csrf='))?.slice('sanctum_csrf='.length);

/** Same-origin by default: the secure session cookie authenticates every call, and mutations carry the CSRF header. */
export function makeListenersClient(baseUrl = globalThis.location?.origin ?? ''): ListenersClient {
    const transformClient = HttpClient.mapRequest((request) => {
        const token = csrfToken();
        return token === undefined ? request : HttpClientRequest.setHeader(request, 'x-csrf-token', decodeURIComponent(token));
    });
    return Effect.runSync(HttpApiClient.make(CaptureApi, { baseUrl, transformClient }).pipe(Effect.provide(FetchHttpClient.layer))).listeners;
}
