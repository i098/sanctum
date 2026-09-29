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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { gitSha, sample, seededRandom, toRecord } from '../benchmarks/measure.ts';
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
  const next = seededRandom(options.seed);
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

/** Times `queries`; the reference check for the first `verify` of them runs after the timed loop. */
async function measure(queries: Float32Array[], directory: Directory, k: number, verify: number) {
  const rankings: string[][] = [];
  const run = await sample(queries.length, async i => rankings.push((await rank(queries[i]!, directory, k)).ids));
  const checked = queries.slice(0, verify);
  const errors = checked.filter((query, i) => reference(query, directory, k).join() !== rankings[i]!.join()).length;
  return { run, errors, checked: checked.length };
}

const record = (measured: Awaited<ReturnType<typeof measure>>, phase: 'cold' | 'steady', options: CosineOptions, fixture_sha256: string, git_sha: string, started_at: string) =>
  toRecord({
    workload_id: 'cosine_ranking',
    phase,
    sample: measured.run,
    fixture_sha256,
    git_sha,
    started_at,
    concurrency: 1,
    errors: measured.errors,
    checked: measured.checked,
    dropped_samples: 0,
    parameters: { directory_size: options.size, dimension: options.dimension, top_k: options.topK, candidate_batch_size: MATCH_BATCH_SIZE, verified_queries: measured.checked },
  });

/** Cold (first query) and steady (remaining queries) records for one directory size. */
export async function runCosineBenchmark(options: CosineOptions, git_sha = gitSha()) {
  const startedAt = new Date().toISOString();
  const data = fixture(options);
  const queries = Array.from({ length: options.queries }, (_, i) => data.queries.subarray(i * options.dimension, (i + 1) * options.dimension));
  const cold = await measure(queries.slice(0, 1), data.directory, options.topK, options.verify);
  const steady = await measure(queries.slice(1), data.directory, options.topK, Math.max(0, options.verify - 1));
  return [record(cold, 'cold', options, data.sha256, git_sha, startedAt), ...(queries.length > 1 ? [record(steady, 'steady', options, data.sha256, git_sha, startedAt)] : [])];
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
