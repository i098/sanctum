// stand-in: replaced by the actions slice at integration
/** Actions group (plan section 12) for the SDKs and MCP tools until the actions slice defines the real one. */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { ActionReceipt } from './actions.ts';
import { Authenticated } from './auth.ts';
import { RequestActionInput, RequestActionOutput } from './integrations.ts';

export class ActionsApi extends HttpApiGroup.make('actions')
  .add(HttpApiEndpoint.post('requestAction', '/actions').setPayload(RequestActionInput).addSuccess(RequestActionOutput, { status: 202 }))
  .add(HttpApiEndpoint.get('getAction')`/actions/${HttpApiSchema.param('action_id', ActionReceipt.fields.action_id)}`.addSuccess(ActionReceipt))
  .middleware(Authenticated)
  .prefix('/api/v1') {}
