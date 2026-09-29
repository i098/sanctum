// stand-in: replaced by the meetings, context, actions, pipedream and kernel slices at integration
/** Handlers for the stand-in v1 groups: every call fails `Unavailable` until the owning slice lands. */
import { HttpApiBuilder } from '@effect/platform';
import { SanctumApi, Unavailable } from '@sanctum/contracts';
import { Effect, Layer } from 'effect';

const missing = (slice: string) => () =>
  Effect.fail(new Unavailable({ message: `Not available until the ${slice} slice is integrated`, retryable: false }));

export const StandInGroupsLive = Layer.mergeAll(
  HttpApiBuilder.group(SanctumApi, 'meetings', handlers =>
    handlers
      .handle('listMeetings', missing('meetings'))
      .handle('getMeeting', missing('meetings'))
      .handle('getTranscript', missing('meetings'))
      .handle('recordingAccess', missing('meetings')),
  ),
  HttpApiBuilder.group(SanctumApi, 'context', handlers =>
    handlers
      .handle('getContext', missing('context'))
      .handle('searchContext', missing('context'))
      .handle('addContextItem', missing('context'))
      .handle('reviseContextItem', missing('context'))
      .handle('getContextChanges', missing('context'))
      .handle('getSource', missing('context')),
  ),
  HttpApiBuilder.group(SanctumApi, 'integrations', handlers =>
    handlers.handle('searchIntegrationActions', missing('pipedream')).handle('getIntegrationAction', missing('pipedream')),
  ),
  HttpApiBuilder.group(SanctumApi, 'actions', handlers =>
    handlers.handle('requestAction', missing('actions')).handle('getAction', missing('actions')),
  ),
  HttpApiBuilder.group(SanctumApi, 'agents', handlers =>
    handlers
      .handle('listAgents', missing('kernel'))
      .handle('createAgent', missing('kernel'))
      .handle('revokeCredential', missing('kernel')),
  ),
);
