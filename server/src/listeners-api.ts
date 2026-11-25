/** `ListenersApi` handlers: device registration, lease heartbeats and archive chunk uploads (T08/T09). */
import { HttpApiBuilder } from '@effect/platform';
import { CurrentAccess, Unavailable } from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import type { SqlError } from '@effect/sql';
import { Effect } from 'effect';
import { heartbeat, registerListener } from './listeners.ts';
import { putChunk } from './recordings.ts';

/** The client sees only a retryable 503; the SQL failure goes to the server log. */
const databaseUnavailable = (operation: string) => (error: SqlError.SqlError) =>
  Effect.logError('Listener database request failed', { operation, message: error.message }).pipe(
    Effect.zipRight(Effect.fail(new Unavailable({ message: 'Database unavailable', retryable: true }))),
  );

export const ListenersLive = HttpApiBuilder.group(SanctumApi, 'listeners', handlers =>
  handlers
    .handle('registerListener', ({ payload }) =>
      Effect.flatMap(CurrentAccess, access => registerListener(access, payload)).pipe(Effect.catchTag('SqlError', databaseUnavailable('registerListener'))),
    )
    .handle('heartbeat', ({ path, payload }) =>
      Effect.flatMap(CurrentAccess, access => heartbeat(access, path.listener_id, payload)).pipe(Effect.catchTag('SqlError', databaseUnavailable('heartbeat'))),
    )
    .handle('putChunk', ({ path, headers, payload }) =>
      Effect.flatMap(CurrentAccess, access => putChunk(access, path.listener_id, path.chunk_id, headers['x-sanctum-manifest'], payload)).pipe(
        Effect.catchTag('SqlError', databaseUnavailable('putChunk')),
      ),
    ),
);
