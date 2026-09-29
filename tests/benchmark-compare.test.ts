import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateResult } from '../benchmarks/result-format.ts';
import { longRunVerdict, matchProblems, saturated, summaryRows, sweepRates } from '../scripts/benchmark-compare.ts';
import { runJob } from '../scripts/benchmark.ts';

const job = { git_sha: 'e'.repeat(40), started_at: '2026-09-29T00:00:00.000Z' };

test('an open-loop pcm job is paced to its offered rate and records it', async () => {
  const [record] = await runJob({ ...job, workload: 'pcm_ingest', frames: 200, rate: 400, concurrency: 8, seed: 1, samples_per_frame: 960 });
  assert.deepEqual(validateResult(record), []);
  assert.deepEqual(record!.offered_load, { per_second: 400, concurrency: 8 });
  assert.equal(record!.repetitions, 200);
  assert.equal(record!.correctness.errors, 0);
  // 200 frames due over 497.5 ms, started at most 1 ms early: the run cannot outpace the offer.
  assert(record!.metrics['throughput']! <= 405, `throughput ${record!.metrics['throughput']}`);
});

test('the sweep doubles past the manifest rates and saturation means under 95% achieved', () => {
  assert.deepEqual(sweepRates([50, 400], 2), [50, 400, 800, 1600]);
  assert.equal(saturated({ metrics: { throughput: 94.9 }, offered_load: { per_second: 100, concurrency: 1 } }), true);
  assert.equal(saturated({ metrics: { throughput: 95 }, offered_load: { per_second: 100, concurrency: 1 } }), false);
});

test('long-run growth is measured from the end of warm-up against the bound', () => {
  const series = [50, 100, 101, 102, 103, 104, 105, 106, 107, 108];
  assert.deepEqual(longRunVerdict(series, 10), { baseline_bytes: 100, peak_bytes: 108, end_bytes: 108, growth_bytes: 8, bound_bytes: 10, within_bound: true });
  assert.equal(longRunVerdict([...series, 200], 10).within_bound, false);
});

const record = (implementation: 'typescript' | 'rust', overrides: Record<string, unknown> = {}) => ({
  workload_id: 'pcm_ingest', implementation, git_sha: 'a'.repeat(40), fixture_sha256: 'b'.repeat(64), started_at: '2026-09-29T00:00:00.000Z', host: null, phase: 'steady' as const,
  repetitions: 10, offered_load: { per_second: 0, concurrency: 1 },
  metrics: { throughput: implementation === 'rust' ? 200 : 100, latency_p50: 1, latency_p95: 2, latency_p99: implementation === 'rust' ? 2 : 4, error_rate: 0, dropped_samples: 0, cpu: 50, rss: 2 ** 20, heap: 0, external: 0, gc_ms: 0, event_loop_delay_p99: 0 },
  correctness: { errors: 0, dropped_samples: 0 }, verified: false as const, parameters: { mode: 'closed_loop' }, ...overrides,
});

test('matched records must share fixture hashes and have no failed operations', () => {
  assert.deepEqual(matchProblems([record('typescript'), record('rust')]), []);
  const problems = matchProblems([record('typescript'), record('rust', { fixture_sha256: 'c'.repeat(64), correctness: { errors: 2, dropped_samples: 0 } })]);
  assert.deepEqual(problems, ['rust pcm_ingest steady 0 closed_loop: 2 failed operations', 'pcm_ingest steady 0 closed_loop: TypeScript and Rust fixture SHA-256 differ']);
});

test('the summary pairs each TypeScript record with its Rust twin and reports ratios', () => {
  const [row, ...rest] = summaryRows([record('typescript'), record('rust'), record('typescript', { phase: 'cold' })]);
  assert.equal(rest.length, 0);
  assert.match(row!, /^\| `pcm_ingest` \| closed_loop steady \| - \| 100\.0 \| 200\.0 \| 0\.50 \|.*\| 2\.00 \| 50 \/ 50 \| 1 \/ 1 \|$/);
});
