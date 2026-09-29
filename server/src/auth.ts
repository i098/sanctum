/**
 * Request-authorization seam (plan section 11). Every adapter (REST, MCP, WebSocket, worker)
 * resolves one `AccessScope` and hands it to domain functions, which never read credentials.
 * The kernel slice supplies the real `Authenticator` (browser sessions, agent tokens, device
 * credentials) and membership/meeting checks; no issuer is chosen here (docs/DECISIONS.md).
 */
import { HttpApiBuilder, HttpServerRequest } from '@effect/platform';
import { type AccessScope, Authenticated, CurrentAccess, Forbidden, SanctumApi, Unauthenticated } from '@sanctum/contracts';
import { Context, Effect, Layer } from 'effect';

export class Authenticator extends Context.Tag('sanctum/Authenticator')<
  Authenticator,
  {
    /** Resolves credentials on the request to an access scope; never trusts client-supplied scopes. */
    readonly authenticate: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<AccessScope, Unauthenticated | Forbidden>;
  }
>() {}

/** Refuses every request: no identity issuer, agent credential store or device enrollment is configured. */
export const UnconfiguredAuthenticator = Layer.succeed(Authenticator, {
  authenticate: () => Effect.fail(new Unauthenticated({ message: 'No authentication method is configured' })),
});

export const AuthenticatedLive = Layer.effect(
  Authenticated,
  Effect.map(Authenticator, authenticator => Effect.flatMap(HttpServerRequest.HttpServerRequest, authenticator.authenticate)),
);

export const SessionLive = HttpApiBuilder.group(SanctumApi, 'session', handlers => handlers.handle('getSession', () => CurrentAccess));
