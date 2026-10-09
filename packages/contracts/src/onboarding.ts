/** The website's first-run welcome; website only, so it is not in OpenAPI, the SDKs or MCP. */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from '@effect/platform';
import { Schema } from 'effect';
import { Authenticated } from './auth.ts';

export const Onboarding = Schema.Struct({
  /** The caller finished or skipped the welcome, on any device; after that only Settings opens it. */
  completed: Schema.Boolean,
  /** The caller's workspace; owners and admins can rename it in the welcome. */
  workspace_name: Schema.String,
});
export type Onboarding = typeof Onboarding.Type;

const RenameWorkspace = Schema.Struct({ name: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(200)) });

export class OnboardingApi extends HttpApiGroup.make('onboarding')
  .add(HttpApiEndpoint.get('getOnboarding', '/onboarding').addSuccess(Onboarding))
  .add(HttpApiEndpoint.post('completeOnboarding', '/onboarding').addSuccess(Onboarding))
  .add(HttpApiEndpoint.post('renameWorkspace', '/workspace/name').setPayload(RenameWorkspace).addSuccess(Onboarding))
  .middleware(Authenticated)
  .annotate(OpenApi.Exclude, true)
  .prefix('/api/v1') {}
