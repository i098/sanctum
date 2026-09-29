/** `/healthz` (process up) and `/readyz` (database reachable and schema current). */
import { HttpApiBuilder } from '@effect/platform';
import { SqlClient } from '@effect/sql';
import { Unavailable } from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Effect } from 'effect';
import type { Migration } from './migrate.ts';
import { pendingMigrations } from './migrate.ts';

const readiness = (migrations: ReadonlyArray<Migration>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT 1`;
    const pending = yield* pendingMigrations(migrations);
    if (pending.length > 0) return yield* new Unavailable({ message: `Pending migrations: ${pending.join(', ')}`, retryable: true });
    return { status: 'ready' as const };
  }).pipe(
    Effect.timeout('2 seconds'),
    Effect.catchIf(
      error => error._tag !== 'Unavailable',
      () => new Unavailable({ message: 'Database unavailable', retryable: true }),
    ),
  );

export const HealthLive = (migrations: ReadonlyArray<Migration>) =>
  HttpApiBuilder.group(SanctumApi, 'health', handlers =>
    handlers.handle('healthz', () => Effect.succeed({ status: 'ok' as const })).handle('readyz', () => readiness(migrations)),
  );
