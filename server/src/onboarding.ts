/**
 * The website's first-run welcome. Completion is kept per principal, so a person who finished or
 * skipped it on one device does not see it again on another; the workspace step shows the
 * workspace name, which owners and admins (`workspace:admin`) can change there.
 */
import { HttpApiBuilder } from '@effect/platform';
import { SqlClient, SqlSchema } from '@effect/sql';
import { type AccessScope, CurrentAccess } from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Effect, Schema } from 'effect';
import { requireScope } from './auth.ts';
import { DbUtc } from './db.ts';

const Row = Schema.Struct({ onboarded_at: Schema.NullOr(DbUtc), name: Schema.String });

const readOnboarding = (access: AccessScope) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    SqlSchema.single({
      Request: Schema.Void,
      Result: Row,
      execute: () => sql`SELECT p.onboarded_at, w.name FROM principals p JOIN workspaces w ON w.id = ${access.workspace_id} WHERE p.id = ${access.principal.id}`,
    })(undefined),
  ).pipe(
    Effect.map(row => ({ completed: row.onboarded_at !== null, workspace_name: row.name })),
    Effect.orDie,
  );

export const OnboardingLive = HttpApiBuilder.group(SanctumApi, 'onboarding', handlers =>
  handlers
    .handle('getOnboarding', () => Effect.flatMap(CurrentAccess, readOnboarding))
    .handle('completeOnboarding', () =>
      Effect.gen(function* () {
        const access = yield* CurrentAccess;
        const sql = yield* SqlClient.SqlClient;
        // Idempotent: the first completion time stays.
        yield* Effect.orDie(sql`UPDATE principals SET onboarded_at = COALESCE(onboarded_at, UTC_TIMESTAMP(6)) WHERE id = ${access.principal.id}`);
        return yield* readOnboarding(access);
      }))
    .handle('renameWorkspace', ({ payload }) =>
      Effect.gen(function* () {
        const access = yield* CurrentAccess;
        yield* requireScope(access, 'workspace:admin');
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.orDie(sql`UPDATE workspaces SET name = ${payload.name} WHERE id = ${access.workspace_id}`);
        return yield* readOnboarding(access);
      })),
);
