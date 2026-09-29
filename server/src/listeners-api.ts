/** `ListenersApi` handlers: device registration, lease heartbeats and archive chunk uploads (T08/T09). */
import { HttpApiBuilder } from '@effect/platform';
import { CurrentAccess, Unavailable } from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Effect } from 'effect';
import { heartbeat, registerListener } from './listeners.ts';
import { putChunk } from './recordings.ts';

const databaseUnavailable = () => new Unavailable({ message: 'Database unavailable', retryable: true });

export const ListenersLive = HttpApiBuilder.group(SanctumApi, 'listeners', handlers =>
  handlers
    .handle('registerListener', ({ payload }) =>
      Effect.flatMap(CurrentAccess, access => registerListener(access, payload)).pipe(Effect.catchTag('SqlError', databaseUnavailable)),
    )
    .handle('heartbeat', ({ path, payload }) =>
      Effect.flatMap(CurrentAccess, access => heartbeat(access, path.listener_id, payload)).pipe(Effect.catchTag('SqlError', databaseUnavailable)),
    )
    .handle('putChunk', ({ path, headers, payload }) =>
      Effect.flatMap(CurrentAccess, access => putChunk(access, path.listener_id, path.chunk_id, headers['x-sanctum-manifest'], payload)).pipe(
        Effect.catchTag('SqlError', databaseUnavailable),
      ),
    ),
);
