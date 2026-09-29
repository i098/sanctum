import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateResult } from '../benchmarks/result-format.ts';
import { runCosineBenchmark } from '../scripts/benchmark-matching.ts';

test('cosine benchmark emits valid unverified records whose rankings equal the full-sort reference', async () => {
  const results = await runCosineBenchmark({ size: 2_500, dimension: 16, queries: 6, verify: 6, topK: 10, seed: 5 }, 'c'.repeat(40));
  assert.deepEqual(results.map(result => [result.phase, result.repetitions]), [['cold', 1], ['steady', 5]]);
  for (const result of results) {
    assert.deepEqual(validateResult(result), []);
    assert.equal(result.correctness.errors, 0);
    assert.equal(result.verified, false);
    assert.equal(result.parameters.verified_queries, result.repetitions);
  }
  assert.equal(results[0]!.fixture_sha256, (await runCosineBenchmark({ size: 2_500, dimension: 16, queries: 6, verify: 0, topK: 10, seed: 5 }, 'c'.repeat(40)))[0]!.fixture_sha256);
});
