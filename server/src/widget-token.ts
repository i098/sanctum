/**
 * `POST /api/v1/workspace/widget-token` (sign-in plan W2): a WorkOS widget token for the website's
 * Team overlay. It needs `workspace:admin` and is issued for the caller's WorkOS user and the
 * organization linked to the caller's workspace, so the widgets manage only that team. WorkOS
 * tokens expire after one hour; this route neither logs nor stores them.
 */
import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from '@effect/platform';
import { SqlClient } from '@effect/sql';
import { NotFound, Unavailable } from '@sanctum/contracts';
import { Effect, Option } from 'effect';
import { Authenticator, requireScope } from './auth.ts';
import { WorkosOrganizations } from './org-sync.ts';
import { errorResponse } from './signin.ts';

export const WidgetTokenLive = HttpApiBuilder.Router.use(router =>
  Effect.gen(function* () {
    const organizations = yield* WorkosOrganizations;
    const authenticator = yield* Authenticator;
    const sql = yield* SqlClient.SqlClient;
    yield* router.post(
      '/api/v1/workspace/widget-token',
      Effect.gen(function* () {
        // Cookie sessions also need the CSRF header here.
        const access = yield* authenticator.authenticate(yield* HttpServerRequest.HttpServerRequest);
        yield* requireScope(access, 'workspace:admin');
        if (Option.isNone(organizations)) return yield* new Unavailable({ message: 'WorkOS organizations are not configured on this server', retryable: false });
        const { client, issuer } = organizations.value;
        const [user] = yield* sql<{ subject: string }>`SELECT subject FROM principal_identities
          WHERE issuer = ${issuer} AND principal_id = ${access.principal.id} ORDER BY verified_at DESC LIMIT 1`;
        if (user === undefined) return yield* new NotFound({ message: 'Your account has no WorkOS sign-in yet. Use Connect sign-in first.' });
        const [org] = yield* sql<{ org_id: string }>`SELECT org_id FROM workspace_orgs WHERE workspace_id = ${access.workspace_id} AND issuer = ${issuer}`;
        if (org === undefined) return yield* new NotFound({ message: 'This workspace is not linked to a WorkOS organization.' });
        const token = yield* client.widgetToken({ user_id: user.subject, organization_id: org.org_id }).pipe(
          Effect.tapError(error => Effect.logWarning('WorkOS widget token refused', { status: error.status, reason: error.message })),
          Effect.mapError(error => new Unavailable({ message: 'WorkOS did not issue a widget token', retryable: error.status === null || error.status >= 500 })),
        );
        return HttpServerResponse.unsafeJson({ token }, { headers: { 'cache-control': 'no-store' } });
      }).pipe(
        Effect.catchTag('SqlError', Effect.die),
        Effect.catchAll(error => Effect.succeed(errorResponse(error))),
      ),
    );
  }),
);
