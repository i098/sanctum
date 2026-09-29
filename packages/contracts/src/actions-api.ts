/** `ActionsApi` (plan section 12). */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { ActionGrant, ActionReceipt, CreateActionGrantInput, ResolveActionInput } from './actions.ts';
import { Authenticated } from './auth.ts';
import { ActionGrantId, ActionId } from './common.ts';
import { RequestActionInput, RequestActionOutput } from './integrations.ts';

const actionId = HttpApiSchema.param('action_id', ActionId);
const grantId = HttpApiSchema.param('grant_id', ActionGrantId);

export class ActionsApi extends HttpApiGroup.make('actions')
  .add(HttpApiEndpoint.post('requestAction', '/actions').setPayload(RequestActionInput).addSuccess(RequestActionOutput, { status: 202 }))
  .add(HttpApiEndpoint.get('getAction')`/actions/${actionId}`.addSuccess(ActionReceipt))
  .add(HttpApiEndpoint.post('resolveAction')`/actions/${actionId}/resolve`.setPayload(ResolveActionInput).addSuccess(ActionReceipt))
  .add(HttpApiEndpoint.post('createActionGrant', '/action-grants').setPayload(CreateActionGrantInput).addSuccess(ActionGrant, { status: 201 }))
  .add(HttpApiEndpoint.del('revokeActionGrant')`/action-grants/${grantId}`.addSuccess(ActionGrant))
  .middleware(Authenticated)
  .prefix('/api/v1') {}
