/**
 * Needs/offers matching (plan section 08) over HTTP and on the job ledger. Both paths run the
 * models slice's exact cosine ranking after a fresh scope check; the `matching.rank` job keeps
 * large rankings off the API process and stores its result as a workspace artifact.
 */
import { createHash, randomUUID } from 'node:crypto';
import { HttpApiBuilder } from '@effect/platform';
import { SqlClient } from '@effect/sql';
import { type AccessScope, CurrentAccess, JobFailure, MatchKind, ProfileId, type ProfileMatches } from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Effect, Schema } from 'effect';
import { requireScope, resolveAccess } from './auth.ts';
import type { ClaimedJob } from './job-types.ts';
import { rankMatches } from './matcher.ts';

const DEFAULT_TOP_K = 10;

/** Ranked matches for one of the caller's workspace profiles; needs `context:read`. */
export const matchesFor = (access: AccessScope, profile_id: ProfileId, kind: 'needs' | 'offers', top_k = DEFAULT_TOP_K) =>
  Effect.gen(function* () {
    yield* requireScope(access, 'context:read');
    const matches = yield* rankMatches(access, { profile_id, kind, top_k });
    return { profile_id, kind, matches } satisfies ProfileMatches;
  });

export const MatchingLive = HttpApiBuilder.group(SanctumApi, 'matching', handlers =>
  handlers.handle('rankMatches', ({ path, urlParams }) => Effect.flatMap(CurrentAccess, access => matchesFor(access, path.profile_id, urlParams.kind, urlParams.top_k))),
);

const RankPayload = Schema.Struct({ profile_id: ProfileId, kind: MatchKind, top_k: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(1, 50))) });

/** `matching.rank`: ranks for the requesting principal and stores the ranking as a JSON artifact. */
export const rankMatchesJob = (job: ClaimedJob) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = yield* Schema.decodeUnknown(RankPayload)(job.payload);
    if (job.requested_by === null) return yield* new JobFailure({ message: 'Matching requires a requesting principal', retryable: false });
    const access = yield* resolveAccess({ workspace_id: job.workspace_id, principal_id: job.requested_by });
    const ranked = yield* matchesFor(access, payload.profile_id, payload.kind, payload.top_k);
    const content = JSON.stringify(ranked);
    const artifact_id = randomUUID();
    yield* sql`INSERT INTO artifacts (id, workspace_id, meeting_id, kind, title, content_type, content, sha256, provenance, created_by, created_at)
      VALUES (${artifact_id}, ${job.workspace_id}, NULL, 'document', ${`Matches for profile ${payload.profile_id} (${payload.kind})`}, 'application/json',
        ${content}, ${createHash('sha256').update(content).digest()}, ${JSON.stringify({ job_id: job.id, profile_id: payload.profile_id, kind: payload.kind })},
        ${job.requested_by}, UTC_TIMESTAMP(6))`;
    return { status: 'succeeded', result: { artifact_id, matches: ranked.matches.length } } as const;
  }).pipe(
    Effect.catchTags({
      ParseError: error => new JobFailure({ message: error.message, retryable: false }),
      Forbidden: error => new JobFailure({ message: error.message, retryable: false }),
      NotFound: error => new JobFailure({ message: error.message, retryable: false }),
      SqlError: error => new JobFailure({ message: error.message, retryable: true }),
    }),
  );
