import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, ProfileId } from '@sanctum/contracts';
import { Effect } from 'effect';
import { MATCH_BATCH_SIZE, type EmbeddingKind, rankMatches, storeEmbedding } from '../src/matcher.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

const MODEL = 'fixture-embed-v1';

const addProfile = (access: AccessScope, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = ProfileId.make(randomUUID());
    yield* sql`INSERT INTO profiles (id, workspace_id, kind, display_name, details, created_at, updated_at)
      VALUES (${id}, ${access.workspace_id}, 'person', ${name}, '{}', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    return id;
  });

const embed = (access: AccessScope, profile_id: ProfileId, kind: EmbeddingKind, vector: number[], extra: { model?: string; source_revision?: number } = {}) =>
  storeEmbedding(access, { profile_id, kind, vector, model: extra.model ?? MODEL, source_revision: extra.source_revision ?? 1 });

const failureTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) => Effect.map(Effect.flip(effect), error => error._tag);

/** Float64 reference cosine, independent of the float32 kernel under test. */
const cosine = (a: number[], b: number[]) => {
  const dotted = a.reduce((sum, value, i) => sum + value * b[i]!, 0);
  return dotted / Math.hypot(...a) / Math.hypot(...b);
};

/** Deterministic pseudo-random vectors (mulberry32). */
const vectors = (seed: number, count: number, dimension: number) => {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296 - 0.5;
  };
  return Array.from({ length: count }, () => Array.from({ length: dimension }, next));
};

describe('semantic matching', () => {
  it.effect('ranks a labeled needs/offers fixture exactly, excluding self, other kinds and other models', () =>
    withDatabase(
      Effect.gen(function* () {
        const [owner] = yield* seedWorkspace('Matching');
        const seeker = yield* addProfile(owner!, 'Needs a designer');
        const designer = yield* addProfile(owner!, 'Offers product design');
        const writer = yield* addProfile(owner!, 'Offers design writing');
        const accountant = yield* addProfile(owner!, 'Offers bookkeeping');
        const otherModel = yield* addProfile(owner!, 'Offers design, other model');
        const need = [0.9, 0.1, 0, 0.2];
        yield* embed(owner!, seeker, 'needs', need);
        yield* embed(owner!, seeker, 'offers', need);
        yield* embed(owner!, designer, 'offers', [0.8, 0.15, 0.05, 0.2]);
        yield* embed(owner!, writer, 'offers', [0.5, 0.5, 0.3, 0.1]);
        yield* embed(owner!, accountant, 'offers', [-0.1, 0.1, 0.95, 0]);
        yield* embed(owner!, designer, 'needs', need);
        yield* embed(owner!, otherModel, 'offers', need, { model: 'other-embed-v2' });

        const ranked = yield* rankMatches(owner!, { profile_id: seeker, kind: 'needs', top_k: 10 });
        expect(ranked.map(match => match.profile_id)).toEqual([designer, writer, accountant]);
        ranked.forEach((match, i) => {
          const expected = cosine(need, [[0.8, 0.15, 0.05, 0.2], [0.5, 0.5, 0.3, 0.1], [-0.1, 0.1, 0.95, 0]][i]!);
          expect(match.score).toBeCloseTo(expected, 6);
        });
        expect(yield* rankMatches(owner!, { profile_id: seeker, kind: 'needs', top_k: 1 })).toEqual([ranked[0]]);
        expect(yield* rankMatches(owner!, { profile_id: seeker, kind: 'needs', top_k: 0 })).toEqual([]);
        const reverse = yield* rankMatches(owner!, { profile_id: designer, kind: 'offers', top_k: 5 });
        expect(reverse.map(match => match.profile_id)).toEqual([seeker]);
      }),
      { migrated: true },
    ),
  );

  it.effect('rejects invalid vectors and model/dimension mismatches without storing them', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [owner] = yield* seedWorkspace('Invalid');
        const profile = yield* addProfile(owner!, 'Someone');
        for (const vector of [[], [0, 0, 0], [1, Number.NaN, 0], [1, Number.POSITIVE_INFINITY, 0], new Array(4_097).fill(1)]) {
          expect(yield* failureTag(embed(owner!, profile, 'needs', vector))).toBe('InvalidEmbedding');
        }
        yield* embed(owner!, profile, 'needs', [1, 2, 3]);
        const mismatch = yield* Effect.flip(embed(owner!, profile, 'offers', [1, 2, 3, 4]));
        expect(mismatch).toMatchObject({ _tag: 'InvalidEmbedding', message: `model ${MODEL} uses dimension 3, got 4` });
        const rows = yield* sql<{ kind: string; dimension: number; bytes: string }>`SELECT kind, dimension, CAST(LENGTH(embedding) AS CHAR) AS bytes FROM profile_embeddings`;
        expect(rows).toEqual([{ kind: 'needs', dimension: 3, bytes: '12' }]);
      }),
      { migrated: true },
    ),
  );

  it.effect('keeps the newest profile revision and replaces the vector on a newer one', () =>
    withDatabase(
      Effect.gen(function* () {
        const [owner] = yield* seedWorkspace('Revisions');
        const seeker = yield* addProfile(owner!, 'Seeker');
        const near = yield* addProfile(owner!, 'Near');
        const far = yield* addProfile(owner!, 'Far');
        yield* embed(owner!, seeker, 'needs', [1, 0]);
        yield* embed(owner!, near, 'offers', [1, 0.1], { source_revision: 2 });
        yield* embed(owner!, far, 'offers', [0, 1]);
        const stale = yield* Effect.flip(embed(owner!, near, 'offers', [0, 1], { source_revision: 1 }));
        expect(stale).toMatchObject({ _tag: 'RevisionConflict', current_revision: 2 });
        expect((yield* rankMatches(owner!, { profile_id: seeker, kind: 'needs', top_k: 2 }))[0]!.profile_id).toBe(near);
        yield* embed(owner!, near, 'offers', [-1, 0], { source_revision: 3 });
        const ranked = yield* rankMatches(owner!, { profile_id: seeker, kind: 'needs', top_k: 2 });
        expect(ranked.map(match => match.profile_id)).toEqual([far, near]);
        expect(ranked[1]!.score).toBeCloseTo(-1, 6);
      }),
      { migrated: true },
    ),
  );

  it.effect('never reads or writes another workspace', () =>
    withDatabase(
      Effect.gen(function* () {
        const [first] = yield* seedWorkspace('First');
        const [second] = yield* seedWorkspace('Second');
        const seeker = yield* addProfile(first!, 'Seeker');
        const local = yield* addProfile(first!, 'Local offer');
        const foreign = yield* addProfile(second!, 'Foreign offer');
        yield* embed(first!, seeker, 'needs', [1, 0, 0]);
        yield* embed(first!, local, 'offers', [0, 1, 0]);
        yield* embed(second!, foreign, 'offers', [1, 0, 0]);
        expect((yield* rankMatches(first!, { profile_id: seeker, kind: 'needs', top_k: 5 })).map(match => match.profile_id)).toEqual([local]);
        expect(yield* failureTag(rankMatches(second!, { profile_id: seeker, kind: 'needs', top_k: 5 }))).toBe('NotFound');
        expect(yield* failureTag(embed(second!, seeker, 'offers', [1, 0, 0]))).toBe('NotFound');
        expect(yield* failureTag(rankMatches(first!, { profile_id: local, kind: 'needs', top_k: 5 }))).toBe('NotFound');
      }),
      { migrated: true },
    ),
  );

  it.effect('pages through more than one batch and matches a brute-force float64 reference', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [owner] = yield* seedWorkspace('Scale');
        const seeker = yield* addProfile(owner!, 'Seeker');
        const [need, ...offers] = vectors(7, MATCH_BATCH_SIZE * 2 + 500 + 1, 32);
        yield* embed(owner!, seeker, 'needs', need!);
        const ids = offers.map(() => ProfileId.make(randomUUID()));
        const profiles = ids.map(id => ({ id, workspace_id: owner!.workspace_id, kind: 'person', display_name: 'Offer', details: '{}', created_at: '2026-09-29 00:00:00', updated_at: '2026-09-29 00:00:00' }));
        yield* sql`INSERT INTO profiles ${sql.insert(profiles)}`;
        yield* Effect.forEach(ids, (id, i) => embed(owner!, id, 'offers', offers[i]!), { concurrency: 4 });
        const ranked = yield* rankMatches(owner!, { profile_id: seeker, kind: 'needs', top_k: 25 });
        const reference = ids
          .map((id, i) => ({ id, score: cosine(need!, offers[i]!) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 25);
        expect(ranked.map(match => match.profile_id)).toEqual(reference.map(entry => entry.id));
        ranked.forEach((match, i) => expect(match.score).toBeCloseTo(reference[i]!.score, 5));
      }),
      { migrated: true },
    ),
    120_000,
  );
});
