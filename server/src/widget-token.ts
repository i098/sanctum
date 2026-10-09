/**
 * Hosted Team routes (sign-in plan W2), all behind `workspace:admin` (cookie sessions also need the
 * CSRF header on POST):
 * - `GET /api/v1/workspace/team`: whether the caller's workspace is linked to a WorkOS organization.
 * - `POST /api/v1/workspace/team`: "Set up team"; the owner links a workspace created before WorkOS.
 * - `POST /api/v1/workspace/widget-token`: a WorkOS widget token for the caller's WorkOS user and the
 *   linked organization, so the widgets manage only that team. WorkOS tokens expire after one hour;
 *   this route neither logs nor stores them.
 */
import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from '@effect/platform';
import { SqlClient, type SqlError } from '@effect/sql';
import { Forbidden, NotFound, type Unauthenticated, Unavailable } from '@sanctum/contracts';
import { Effect, Option } from 'effect';
import { Authenticator, requireScope } from './auth.ts';
import { linkExistingWorkspace, WorkosOrganizations } from './org-sync.ts';
import { errorResponse } from './signin.ts';

export const WidgetTokenLive = HttpApiBuilder.Router.use(router =>
  Effect.gen(function* () {
    const organizations = yield* WorkosOrganizations;
    const authenticator = yield* Authenticator;
    const sql = yield* SqlClient.SqlClient;

    /** The caller's access with `workspace:admin` and the WorkOS settings. */
    const team = Effect.gen(function* () {
      const access = yield* authenticator.authenticate(yield* HttpServerRequest.HttpServerRequest);
      yield* requireScope(access, 'workspace:admin');
      if (Option.isNone(organizations)) return yield* new Unavailable({ message: 'WorkOS organizations are not configured on this server', retryable: false });
      return { access, settings: organizations.value };
    });
    /** The caller's WorkOS user id. */
    const workosUser = (principal_id: string, issuer: string) =>
      Effect.gen(function* () {
        const [user] = yield* sql<{ subject: string }>`SELECT subject FROM principal_identities
          WHERE issuer = ${issuer} AND principal_id = ${principal_id} ORDER BY verified_at DESC LIMIT 1`;
        if (user === undefined) return yield* new NotFound({ message: 'Your account has no WorkOS sign-in yet. Use Connect sign-in first.' });
        return user.subject;
      });
    const answer = (route: Effect.Effect<HttpServerResponse.HttpServerResponse, Unauthenticated | Forbidden | NotFound | Unavailable | SqlError.SqlError, HttpServerRequest.HttpServerRequest | SqlClient.SqlClient | WorkosOrganizations>) =>
      route.pipe(
        Effect.catchTag('SqlError', Effect.die),
        Effect.catchAll(error => Effect.succeed(errorResponse(error))),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(WorkosOrganizations, organizations),
      );

    yield* router.get(
      '/api/v1/workspace/team',
      answer(
        Effect.gen(function* () {
          const { access, settings } = yield* team;
          const [org] = yield* sql`SELECT 1 FROM workspace_orgs WHERE workspace_id = ${access.workspace_id} AND issuer = ${settings.issuer}`;
          return HttpServerResponse.unsafeJson({ linked: org !== undefined }, { headers: { 'cache-control': 'no-store' } });
        }),
      ),
    );
    yield* router.post(
      '/api/v1/workspace/team',
      answer(
        Effect.gen(function* () {
          const { access, settings } = yield* team;
          if (access.role !== 'owner') return yield* new Forbidden({ message: 'Only the workspace owner can set up the team' });
          const subject = yield* workosUser(access.principal.id, settings.issuer);
          yield* linkExistingWorkspace(settings, access.workspace_id, { issuer: settings.issuer, subject }).pipe(
            Effect.catchTag('WorkosFailure', error =>
              Effect.zipRight(
                Effect.logWarning('WorkOS team setup failed', { status: error.status, reason: error.message }),
                new Unavailable({ message: 'WorkOS did not set up the team. Try again.', retryable: error.status === null || error.status >= 500 }),
              ),
            ),
          );
          return HttpServerResponse.unsafeJson({ linked: true }, { headers: { 'cache-control': 'no-store' } });
        }),
      ),
    );
    yield* router.post(
      '/api/v1/workspace/widget-token',
      answer(
        Effect.gen(function* () {
          const { access, settings } = yield* team;
          const subject = yield* workosUser(access.principal.id, settings.issuer);
          const [org] = yield* sql<{ org_id: string }>`SELECT org_id FROM workspace_orgs WHERE workspace_id = ${access.workspace_id} AND issuer = ${settings.issuer}`;
          if (org === undefined) return yield* new NotFound({ message: 'This workspace is not linked to a WorkOS organization.' });
          const token = yield* settings.client.widgetToken({ user_id: subject, organization_id: org.org_id }).pipe(
            Effect.tapError(error => Effect.logWarning('WorkOS widget token refused', { status: error.status, reason: error.message })),
            Effect.mapError(error => new Unavailable({ message: 'WorkOS did not issue a widget token', retryable: error.status === null || error.status >= 500 })),
          );
          return HttpServerResponse.unsafeJson({ token }, { headers: { 'cache-control': 'no-store' } });
        }),
      ),
    );
  }),
);
