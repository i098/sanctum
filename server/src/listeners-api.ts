/** `ListenersApi` handlers: device registration, lease heartbeats and archive chunk uploads (T08/T09). */
import { HttpApiBuilder } from '@effect/platform';
import { CurrentAccess, SanctumApi, Unavailable } from '@sanctum/contracts';
import { Effect } from 'effect';
import { claimGroupLease } from './capture-groups.ts';
import { heartbeat, registerListener } from './listeners.ts';
import { putChunk } from './recordings.ts';

const databaseUnavailable = () => new Unavailable({ message: 'Database unavailable', retryable: true });

export const ListenersLive = HttpApiBuilder.group(SanctumApi, 'listeners', handlers =>
  handlers
    .handle('registerListener', ({ payload }) =>
      Effect.flatMap(CurrentAccess, access => registerListener(access, payload)).pipe(Effect.catchTag('SqlError', databaseUnavailable)),
    )
    .handle('heartbeat', ({ path, payload }) =>
      Effect.gen(function* () {
        const access = yield* CurrentAccess;
        const { capture_group_id, ...receipt } = yield* heartbeat(access, path.listener_id, payload);
        if (!receipt.owner || capture_group_id === null) return receipt;
        return yield* claimGroupLease({ workspace_id: access.workspace_id, capture_group_id, listener_id: path.listener_id, lease_generation: receipt.lease_generation });
      }).pipe(Effect.catchTag('SqlError', databaseUnavailable)),
    )
    .handle('putChunk', ({ path, headers, payload }) =>
      Effect.flatMap(CurrentAccess, access => putChunk(access, path.listener_id, path.chunk_id, headers['x-sanctum-manifest'], payload)).pipe(
        Effect.catchTag('SqlError', databaseUnavailable),
      ),
    ),
);
