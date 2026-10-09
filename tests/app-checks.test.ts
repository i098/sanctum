import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { validateManifest, validateResult } from '../benchmarks/result-format.ts';
import { childEnv } from '../scripts/check-app.ts';

const manifest = () => JSON.parse(readFileSync(new URL('../benchmarks/workload.json', import.meta.url), 'utf8'));

const result = (overrides: Record<string, unknown> = {}) => ({
  workload_id: 'pcm_ingest',
  implementation: 'typescript',
  git_sha: 'a'.repeat(40),
  fixture_sha256: 'b'.repeat(64),
  started_at: '2026-09-29T00:00:00.000Z',
  host: null,
  phase: 'steady',
  repetitions: 5,
  offered_load: { per_second: 400, concurrency: 8 },
  metrics: {
    throughput: 400, latency_p50: 1, latency_p95: 2, latency_p99: 3, error_rate: 0, dropped_samples: 0,
    cpu: 12, rss: 1e8, heap: 5e7, external: 1e6, gc_ms: 4, event_loop_delay_p99: 2,
  },
  correctness: { errors: 0, dropped_samples: 0 },
  verified: false,
  ...overrides,
});

test('committed benchmark manifest is valid and declares unverified hardware', () => {
  assert.deepEqual(validateManifest(), []);
  assert.equal(manifest().reference_hardware.status, 'unverified');
});

test('manifest missing a plan workload is rejected', () => {
  const value = manifest();
  value.workloads = value.workloads.filter((workload: { id: string }) => workload.id !== 'cosine_ranking');
  assert.match(validateManifest(value).join('\n'), /workloads ids must list exactly/);
});

test('parity gate looser than the plan tolerance is rejected', () => {
  const value = manifest();
  value.workloads[0].parity_gate.min_throughput_ratio = 0.5;
  value.workloads[1].parity_gate.max_latency_ratio_p99 = 1.5;
  const errors = validateManifest(value);
  assert.equal(errors.length, 2);
  assert.match(errors[0]!, /workloads\[0\]\.parity_gate\.min_throughput_ratio/);
  assert.match(errors[1]!, /workloads\[1\]\.parity_gate\.max_latency_ratio_p99/);
});

test('verified result on unverified reference hardware is rejected', () => {
  assert.deepEqual(validateResult(result()), []);
  assert.match(validateResult(result({ verified: true })).join('\n'), /requires verified manifest reference hardware/);
  assert.match(validateResult(result({ host: 'laptop' })).join('\n'), /result\.host must equal/);
});

test('verified result is accepted only against complete verified hardware', () => {
  const value = manifest();
  value.reference_hardware = { status: 'verified', name: 'bench-1', cpu_model: 'Example CPU', cores: 8, ram_gb: 32, os: 'Ubuntu 24.04' };
  assert.deepEqual(validateResult(result({ verified: true, host: 'bench-1' }), value), []);
  value.reference_hardware.os = null;
  assert.match(validateManifest(value).join('\n'), /must be complete when verified/);
});

test('child environment forces test mode and drops provider credentials', () => {
  const env = childEnv({ PATH: '/bin', SANCTUM_ENV: 'production', ANTHROPIC_API_KEY: 'x', AWS_REGION: 'y', R2_BUCKET: 'z', PIPEDREAM_CLIENT_SECRET: 'w', CARTESIA_API_KEY: 'v', WORKERS_AI_API_TOKEN: 'u', MY_AWS_NOTE: 'kept' });
  assert.deepEqual(env, { PATH: '/bin', SANCTUM_ENV: 'test', MY_AWS_NOTE: 'kept' });
});
