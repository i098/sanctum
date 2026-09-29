// stand-in: replaced by the actions slice at integration
/** Handlers for the stand-in actions group: every call fails `Unavailable` until the actions slice lands. */
import { HttpApiBuilder } from '@effect/platform';
import { Unavailable } from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Effect } from 'effect';

const missing = () => Effect.fail(new Unavailable({ message: 'Not available until the actions slice is integrated', retryable: false }));

export const ActionsStandInLive = HttpApiBuilder.group(SanctumApi, 'actions', handlers =>
  handlers.handle('requestAction', missing).handle('getAction', missing),
);
