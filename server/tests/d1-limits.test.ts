import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { dbLayer } from '../src/db.ts';
import { compoundGroups, inList } from '../src/sql-dialect.ts';

const withDb = <A, E>(use: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.provide(use, dbLayer({ url: ':memory:' }));
const ids = Array.from({ length: 250 }, (_, index) => `id-${index}`);

/** The local SQLite backend enforces D1's statement limits, so these fail here the way they fail in production. */
describe('D1 statement limits', () => {
  it.effect('refuse more than 100 bound parameters and more than 5 compound SELECT terms', () =>
    withDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const binding = yield* Effect.flip(sql`SELECT 1 WHERE 'x' IN ${sql.in(ids)}`);
        expect(binding.message).toMatch(/too many SQL variables/);
        const compound = yield* Effect.flip(sql.unsafe(Array.from({ length: 6 }, () => 'SELECT 1').join(' UNION ALL ')));
        expect(compound.message).toMatch(/too many terms in compound SELECT/);
      }),
    ),
  );

  it.effect('inList matches a list of any length with one bound parameter', () =>
    withDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('CREATE TABLE things (id TEXT PRIMARY KEY)');
        yield* sql`INSERT INTO things ${sql.insert(['id-0', 'id-249', 'other'].map(id => ({ id })))}`;
        expect((yield* sql<{ id: string }>`SELECT id FROM things WHERE ${inList(sql, 'id', ids)} ORDER BY id`).map(row => row.id)).toEqual(['id-0', 'id-249']);
        expect(yield* sql`SELECT id FROM things WHERE ${inList(sql, 'id', [])}`).toEqual([]);
      }),
    ),
  );

  it('compoundGroups keeps every term and no group over the limit', () => {
    const groups = compoundGroups(Array.from({ length: 47 }, (_, index) => index));
    expect(groups.every(group => group.length <= 5)).toBe(true);
    expect(groups.flat()).toEqual(Array.from({ length: 47 }, (_, index) => index));
  });
});
