import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, JobId, ProfileId } from '@sanctum/contracts';
import { Effect } from 'effect';
import { storeEmbedding } from '../src/matcher.ts';
import { matchesFor, rankMatchesJob } from '../src/matching.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

const addProfile = (access: AccessScope, name: string, kind: 'needs' | 'offers', vector: number[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = ProfileId.make(randomUUID());
    yield* sql`INSERT INTO profiles (id, workspace_id, kind, display_name, details, created_at, updated_at)
      VALUES (${id}, ${access.workspace_id}, 'person', ${name}, '{}', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    yield* storeEmbedding(access, { profile_id: id, kind, vector, model: 'fixture-embed-v1', source_revision: 1 });
    return id;
  });

describe('matching under the served access model', () => {
  it.effect('ranks offers against needs within one workspace and requires context:read', () =>
    withDatabase(
      Effect.gen(function* () {
        const [owner] = yield* seedWorkspace('Acme', ['owner']);
        const [other] = yield* seedWorkspace('Other', ['owner']);
        const seeker = yield* addProfile(owner!, 'Seeker', 'needs', [1, 0, 0]);
        const close = yield* addProfile(owner!, 'Close', 'offers', [0.9, 0.1, 0]);
        const far = yield* addProfile(owner!, 'Far', 'offers', [0, 1, 0]);
        yield* addProfile(other!, 'Elsewhere', 'offers', [1, 0, 0]);
        const ranked = yield* matchesFor(owner!, seeker, 'needs', 5);
        expect(ranked.matches.map(match => match.profile_id)).toEqual([close, far]);
        expect(ranked.matches[0]!.score).toBeGreaterThan(0.99);
        expect((yield* Effect.flip(matchesFor({ ...owner!, scopes: ['recordings:read'] }, seeker, 'needs')))._tag).toBe('Forbidden');
        expect((yield* Effect.flip(matchesFor(other!, seeker, 'needs')))._tag).toBe('NotFound');
      }),
      { migrated: true },
    ),
  );

  it.effect('the matching.rank job ranks for its requester and stores the result as an artifact', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [owner] = yield* seedWorkspace('Jobs', ['owner']);
        const seeker = yield* addProfile(owner!, 'Seeker', 'needs', [1, 0]);
        const helper = yield* addProfile(owner!, 'Helper', 'offers', [1, 0.2]);
        const job = {
          id: JobId.make(randomUUID()), workspace_id: owner!.workspace_id, kind: 'matching.rank' as const, work_key: seeker,
          payload: { profile_id: seeker, kind: 'needs', top_k: 3 }, requested_by: owner!.principal.id, source_revision: null, attempt: 1, lease_generation: 1,
        };
        const outcome = yield* rankMatchesJob(job);
        expect(outcome).toMatchObject({ status: 'succeeded', result: { matches: 1 } });
        const [artifact] = yield* sql<{ content: string; kind: string }>`SELECT content, kind FROM artifacts WHERE id = ${String(outcome.result.artifact_id)}`;
        expect(artifact!.kind).toBe('document');
        expect(JSON.parse(artifact!.content)).toMatchObject({ profile_id: seeker, kind: 'needs', matches: [{ profile_id: helper }] });
        expect(yield* Effect.flip(rankMatchesJob({ ...job, requested_by: null }))).toMatchObject({ _tag: 'JobFailure', retryable: false });
      }),
      { migrated: true },
    ),
  );
});
