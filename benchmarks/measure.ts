/**
 * Shared measurement for the section 04 workloads: deterministic fixture randomness, a timed
 * sampler recording latency, CPU, GC, event-loop delay and peak memory, and the result record
 * `result-format.ts` validates. Records stay `verified: false` until a controlled host exists.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

interface Manifest { reference_hardware: { name: string | null } }
const manifest: Manifest = JSON.parse(readFileSync(new URL('./workload.json', import.meta.url), 'utf8'));

/** mulberry32: uniform values in [-0.5, 0.5), identical on every run for one seed. */
export function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296 - 0.5;
  };
}

export interface Sample {
  readonly latencies: number[];
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly gcMs: number;
  readonly loopP99Ms: number;
  readonly peak: { rss: number; heap: number; external: number };
  /** RSS about once per second of wall time, for long-run memory bounds. */
  readonly rssSeries: number[];
}

/**
 * Runs `op` for i = 0..count-1 sequentially and measures each call plus process resources.
 * With `rate` > 0 (open loop), operation i is due at i/rate seconds: a late operation's latency
 * counts from its due time, so a stall cannot hide tail latency, and the loop sleeps only when
 * at least 1 ms ahead. benchmarks/rust/src/measure.rs implements the same schedule.
 */
export async function sample(count: number, op: (i: number) => unknown, rate = 0): Promise<Sample> {
  const loop = monitorEventLoopDelay({ resolution: 1 });
  let gcMs = 0;
  const gc = new PerformanceObserver(list => list.getEntries().forEach(entry => (gcMs += entry.duration)));
  gc.observe({ entryTypes: ['gc'] });
  const peak = { rss: 0, heap: 0, external: 0 };
  const latencies: number[] = [];
  const rssSeries: number[] = [];
  let nextSeries = 0;
  loop.enable();
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    const due = rate > 0 ? started + (i * 1000) / rate : performance.now();
    const ahead = due - performance.now();
    if (ahead >= 1) await sleep(ahead);
    const begin = Math.min(due, performance.now());
    await op(i);
    const end = performance.now();
    latencies.push(end - begin);
    if (i % 64 === 0) {
      const memory = process.memoryUsage();
      peak.rss = Math.max(peak.rss, memory.rss);
      peak.heap = Math.max(peak.heap, memory.heapUsed);
      peak.external = Math.max(peak.external, memory.external + memory.arrayBuffers);
    }
    if (end - started >= nextSeries) {
      rssSeries.push(process.memoryUsage.rss());
      nextSeries = end - started + 1000;
    }
  }
  const wallMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  loop.disable();
  gc.disconnect();
  return { latencies, wallMs, cpuMs: (used.user + used.system) / 1000, gcMs, loopP99Ms: loop.percentile(99) / 1e6, peak, rssSeries };
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

export const gitSha = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

export interface RecordInput {
  readonly workload_id: string;
  readonly phase: 'cold' | 'steady';
  readonly sample: Sample;
  readonly fixture_sha256: string;
  readonly git_sha: string;
  readonly started_at: string;
  readonly concurrency: number;
  /** Offered operations per second of an open-loop run; 0 for sequential closed-loop runs. */
  readonly rate?: number;
  readonly errors: number;
  readonly checked: number;
  readonly dropped_samples: number;
  readonly parameters: Record<string, unknown>;
}

/** One result record in the `result-format.ts` shape. */
export interface BenchmarkRecord {
  readonly workload_id: string;
  readonly implementation: 'typescript';
  readonly git_sha: string;
  readonly fixture_sha256: string;
  readonly started_at: string;
  readonly host: string | null;
  readonly phase: 'cold' | 'steady';
  readonly repetitions: number;
  readonly offered_load: { readonly per_second: number; readonly concurrency: number };
  readonly metrics: { readonly [metric: string]: number };
  readonly correctness: { readonly errors: number; readonly dropped_samples: number };
  readonly verified: false;
  readonly parameters: Record<string, unknown>;
}

/** Builds a record; `verified` stays false (no controlled benchmark host). */
export function toRecord(input: RecordInput): BenchmarkRecord {
  const { sample: run } = input;
  const sorted = [...run.latencies].sort((a, b) => a - b);
  return {
    workload_id: input.workload_id,
    implementation: 'typescript',
    git_sha: input.git_sha,
    fixture_sha256: input.fixture_sha256,
    started_at: input.started_at,
    host: manifest.reference_hardware.name,
    phase: input.phase,
    repetitions: run.latencies.length,
    offered_load: { per_second: input.rate ?? 0, concurrency: input.concurrency },
    metrics: {
      throughput: run.latencies.length / (run.wallMs / 1000),
      latency_p50: percentile(sorted, 50),
      latency_p95: percentile(sorted, 95),
      latency_p99: percentile(sorted, 99),
      error_rate: input.checked === 0 ? 0 : input.errors / input.checked,
      dropped_samples: input.dropped_samples,
      cpu: (100 * run.cpuMs) / run.wallMs,
      rss: run.peak.rss,
      heap: run.peak.heap,
      external: run.peak.external,
      gc_ms: run.gcMs,
      event_loop_delay_p99: run.loopP99Ms,
    },
    correctness: { errors: input.errors, dropped_samples: input.dropped_samples },
    verified: false,
    parameters: run.rssSeries.length > 1 ? { ...input.parameters, rss_series_bytes: run.rssSeries } : input.parameters,
  };
}
