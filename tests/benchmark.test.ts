import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBenchmarks } from '../scripts/benchmark.ts';

test('smoke benchmarks emit valid unverified records with correct results and name unrun MySQL workloads', async () => {
  const { records, unrun, problems } = await runBenchmarks({ smoke: true, mysqlUrl: undefined }, 'd'.repeat(40));
  assert.deepEqual(problems, []);
  assert.deepEqual(records.map(record => `${record.workload_id}:${record.phase}`), ['pcm_ingest:steady', 'cosine_ranking:cold', 'cosine_ranking:steady']);
  assert(records.every(record => record.verified === false && record.correctness.errors === 0 && record.fixture_sha256.length === 64));
  assert.deepEqual(unrun, ['archive_streaming', 'transcript_ingest', 'context_read_write']);
});
