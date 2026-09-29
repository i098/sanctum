/** Semantic needs/offers matching over profile embeddings (plan section 08). */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { ProfileId } from './common.ts';

export const MatchKind = Schema.Literal('needs', 'offers');

export const ProfileMatch = Schema.Struct({ profile_id: ProfileId, score: Schema.Number });

/** Ranked matches for one profile: exact cosine, same workspace, model and dimension. */
export const ProfileMatches = Schema.Struct({
  profile_id: ProfileId,
  kind: MatchKind,
  matches: Schema.Array(ProfileMatch),
});
export type ProfileMatches = typeof ProfileMatches.Type;

export const MatchParams = Schema.Struct({
  kind: MatchKind,
  top_k: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 50))),
});

/** Registered in api.ts with the `Authenticated` middleware; handlers live in server/src/matching.ts. */
export class MatchingApi extends HttpApiGroup.make('matching')
  .add(HttpApiEndpoint.get('rankMatches')`/profiles/${HttpApiSchema.param('profile_id', ProfileId)}/matches`.setUrlParams(MatchParams).addSuccess(ProfileMatches))
  .prefix('/api/v1') {}
