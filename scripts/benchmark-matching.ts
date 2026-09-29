/**
 * `cosine_ranking` benchmark (benchmarks/workload.json, plan section 04): exact float32 cosine
 * top-k with the `dot`/`TopK` kernel and batch size `rankMatches` uses, yielding to the event
 * loop between batches as the MySQL page reads do. The directory-size target is the largest
 * manifest size, 100,000 profiles x 1,024 dimensions in one workspace.
 *
 * Prints one validated result record per directory size and phase (cold = first query).
 * Records stay `verified: false` and parity stays unclaimed until a controlled host and the
 * matched Rust run exist.
 *
 * Usage: node scripts/benchmark-matching.ts [--sizes 1000,10000] [--queries 100] [--verify 20] [--dimension 1024]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { validateResult } from '../benchmarks/result-format.ts';
import { dot, MATCH_BATCH_SIZE, TopK } from '../server/src/matcher.ts';

interface Workload { parameters: { dimension: number; directory_sizes: number[]; top_k: number; queries: number }; fixture: { seed: number } }
interface Manifest { reference_hardware: { name: string | null }; workloads: Array<Workload & { id: string }> }

const manifest: Manifest = JSON.parse(readFileSync(new URL('../benchmarks/workload.json', import.meta.url), 'utf8'));
const workload = manifest.workloads.find(entry => entry.id === 'cosine_ranking')!;

export interface CosineOptions {
  readonly size: number;
  readonly dimension: number;
  readonly queries: number;
  /** Queries whose top-k is checked against a full-sort reference, outside the timed region. */
  readonly verify: number;
  readonly topK: number;
  readonly seed: number;
}

/** Fixture generator `float32-embeddings-v1`: mulberry32 uniform values, each vector unit length. */
function fixture(options: CosineOptions) {
  let state = options.seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296 - 0.5;
  };
  const unitVectors = (count: number) => {
    const values = new Float32Array(count * options.dimension);
    for (let row = 0; row < count; row++) {
      const start = row * options.dimension;
      let sum = 0;
      for (let i = 0; i < options.dimension; i++) sum += (values[start + i] = next()) ** 2;
      const norm = Math.sqrt(sum);
      for (let i = 0; i < options.dimension; i++) values[start + i]! /= norm;
    }
    return values;
  };
  const directory = Array.from({ length: Math.ceil(options.size / MATCH_BATCH_SIZE) }, (_, b) => {
    const ids = Array.from({ length: Math.min(MATCH_BATCH_SIZE, options.size - b * MATCH_BATCH_SIZE) }, (_, row) => String(b * MATCH_BATCH_SIZE + row).padStart(9, '0'));
    return { ids, vectors: unitVectors(ids.length) };
  });
  const queries = unitVectors(options.queries);
  const hash = createHash('sha256');
  [...directory.map(batch => batch.vectors), queries].forEach(values => hash.update(new Uint8Array(values.buffer)));
  return { directory, queries, sha256: hash.digest('hex') };
}

type Directory = ReadonlyArray<{ readonly ids: ReadonlyArray<string>; readonly vectors: Float32Array }>;

async function rank(query: Float32Array, directory: Directory, k: number): Promise<TopK> {
  const best = new TopK(k);
  for (const batch of directory) {
    for (let row = 0; row < batch.ids.length; row++) best.offer(batch.ids[row]!, dot(query, batch.vectors, row * query.length));
    await yieldToLoop();
  }
  return best;
}

/** Full-sort reference with the same float32 products; ties break on the lower profile ID. */
function reference(query: Float32Array, directory: Directory, k: number): string[] {
  const scored = directory.flatMap(batch => batch.ids.map((id, row) => ({ id, score: dot(query, batch.vectors, row * query.length) })));
  return scored.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id)).slice(0, k).map(entry => entry.id);
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

interface Sample { latencies: number[]; verified: number; errors: number; wallMs: number; cpuMs: number; gcMs: number; loopP99Ms: number; peak: { rss: number; heap: number; external: number } }

/** Times `queries`; the reference check for the first `verify` of them runs after the timed loop. */
async function measure(queries: Float32Array[], directory: Directory, k: number, verify: number): Promise<Sample> {
  const loop = monitorEventLoopDelay({ resolution: 1 });
  let gcMs = 0;
  const gc = new PerformanceObserver(list => list.getEntries().forEach(entry => (gcMs += entry.duration)));
  gc.observe({ entryTypes: ['gc'] });
  const peak = { rss: 0, heap: 0, external: 0 };
  const latencies: number[] = [];
  const rankings: string[][] = [];
  loop.enable();
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (const query of queries) {
    const begin = performance.now();
    const best = await rank(query, directory, k);
    latencies.push(performance.now() - begin);
    rankings.push(best.ids);
    const memory = process.memoryUsage();
    peak.rss = Math.max(peak.rss, memory.rss);
    peak.heap = Math.max(peak.heap, memory.heapUsed);
    peak.external = Math.max(peak.external, memory.external + memory.arrayBuffers);
  }
  const wallMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  loop.disable();
  gc.disconnect();
  const checked = queries.slice(0, verify);
  const errors = checked.filter((query, i) => reference(query, directory, k).join() !== rankings[i]!.join()).length;
  return { latencies, verified: checked.length, errors, wallMs, cpuMs: (used.user + used.system) / 1000, gcMs, loopP99Ms: loop.percentile(99) / 1e6, peak };
}

function record(sample: Sample, phase: 'cold' | 'steady', options: CosineOptions, fixtureSha256: string, gitSha: string, startedAt: string) {
  const sorted = [...sample.latencies].sort((a, b) => a - b);
  return {
    workload_id: 'cosine_ranking',
    implementation: 'typescript',
    git_sha: gitSha,
    fixture_sha256: fixtureSha256,
    started_at: startedAt,
    host: manifest.reference_hardware.name,
    phase,
    repetitions: sample.latencies.length,
    offered_load: { per_second: 0, concurrency: 1 },
    metrics: {
      throughput: sample.latencies.length / (sample.wallMs / 1000),
      latency_p50: percentile(sorted, 50),
      latency_p95: percentile(sorted, 95),
      latency_p99: percentile(sorted, 99),
      error_rate: sample.verified === 0 ? 0 : sample.errors / sample.verified,
      dropped_samples: 0,
      cpu: (100 * sample.cpuMs) / sample.wallMs,
      rss: sample.peak.rss,
      heap: sample.peak.heap,
      external: sample.peak.external,
      gc_ms: sample.gcMs,
      event_loop_delay_p99: sample.loopP99Ms,
    },
    correctness: { errors: sample.errors, dropped_samples: 0 },
    verified: false,
    parameters: { directory_size: options.size, dimension: options.dimension, top_k: options.topK, candidate_batch_size: MATCH_BATCH_SIZE, verified_queries: sample.verified },
  };
}

/** Cold (first query) and steady (remaining queries) records for one directory size. */
export async function runCosineBenchmark(options: CosineOptions, gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()) {
  const startedAt = new Date().toISOString();
  const data = fixture(options);
  const queries = Array.from({ length: options.queries }, (_, i) => data.queries.subarray(i * options.dimension, (i + 1) * options.dimension));
  const cold = await measure(queries.slice(0, 1), data.directory, options.topK, options.verify);
  const steady = await measure(queries.slice(1), data.directory, options.topK, Math.max(0, options.verify - 1));
  return [record(cold, 'cold', options, data.sha256, gitSha, startedAt), ...(queries.length > 1 ? [record(steady, 'steady', options, data.sha256, gitSha, startedAt)] : [])];
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { sizes: { type: 'string' }, queries: { type: 'string' }, verify: { type: 'string' }, dimension: { type: 'string' } } });
  const parameters = workload.parameters;
  const sizes = values.sizes?.split(',').map(Number) ?? parameters.directory_sizes;
  let failed = false;
  for (const size of sizes) {
    const options: CosineOptions = {
      size,
      dimension: Number(values.dimension ?? parameters.dimension),
      queries: Number(values.queries ?? parameters.queries),
      verify: Number(values.verify ?? 20),
      topK: parameters.top_k,
      seed: workload.fixture.seed,
    };
    for (const result of await runCosineBenchmark(options)) {
      const errors = validateResult(result);
      errors.forEach(error => console.error(error));
      failed ||= errors.length > 0 || result.correctness.errors > 0;
      console.log(JSON.stringify(result));
      const m = result.metrics;
      console.error(`${size} x ${options.dimension} ${result.phase}: ${m.throughput.toFixed(1)} q/s, p50 ${m.latency_p50.toFixed(2)} ms, p99 ${m.latency_p99.toFixed(2)} ms, loop p99 ${m.event_loop_delay_p99.toFixed(2)} ms, rss ${(m.rss / 2 ** 20).toFixed(0)} MiB, errors ${result.correctness.errors}`);
    }
  }
  if (failed) process.exitCode = 1;
}
