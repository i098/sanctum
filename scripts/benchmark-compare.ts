/**
 * Matched TypeScript/Rust benchmark runner (plan section 04, T26). Builds the benchmark-only Rust
 * reference (benchmarks/rust), then gives both implementations the same job JSON, each in its own
 * process: `node scripts/benchmark.ts --job` and the Rust release binary. It runs
 *
 * - closed-loop `pcm_ingest` and `cosine_ranking`;
 * - an open-loop `pcm_ingest` sweep over the manifest's offered frame rates, doubling past them
 *   until each implementation saturates (achieved < 95% of offered);
 * - a long-run `pcm_ingest` soak whose RSS growth after warm-up must stay within a declared bound.
 *
 * Records stay `verified: false` and carry the host description, the source SHA-256 of each
 * implementation and the runtime. Timings from a shared host neither claim nor refute parity.
 *
 * Usage: node scripts/benchmark-compare.ts [--smoke] [--out file.jsonl] [--soak-seconds 300]
 * (needs `cargo` on PATH; the three database workloads run only through scripts/benchmark.ts: the Rust reference has no SQLite driver)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type BenchmarkRecord, gitSha } from '../benchmarks/measure.ts';
import { validateResult } from '../benchmarks/result-format.ts';
import type { Job } from './benchmark.ts';
import { childEnv } from './check-app.ts';

type Implementation = 'typescript' | 'rust';
type Result = Omit<BenchmarkRecord, 'implementation'> & { readonly implementation: Implementation };
type Mode = 'closed_loop' | 'open_loop_sweep' | 'long_run';

const IMPLEMENTATIONS: ReadonlyArray<Implementation> = ['typescript', 'rust'];
const CARGO_MANIFEST = fileURLToPath(new URL('../benchmarks/rust/Cargo.toml', import.meta.url));
/** Declared harness bound for the soak, not a T01 budget: RSS may grow at most this much after warm-up. */
const SOAK_GROWTH_BOUND_BYTES = 16 * 2 ** 20;
const SATURATION_RATIO = 0.95;

interface Workload { id: string; fixture: { seed: number }; parameters: Record<string, number | number[]> }
const manifest: { reference_hardware: { name: string | null }; workloads: Workload[] } = JSON.parse(readFileSync(new URL('../benchmarks/workload.json', import.meta.url), 'utf8'));
const workload = (id: string) => manifest.workloads.find(entry => entry.id === id)!;

/** SHA-256 over the tracked files under `paths`, path and content, in path order. */
function sourceSha(paths: ReadonlyArray<string>): string {
  const files = execFileSync('git', ['ls-files', '--', ...paths], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  return files.reduce((hash, file) => hash.update(`${file}\0`).update(readFileSync(file)).update('\0'), createHash('sha256')).digest('hex');
}

const SOURCES: Record<Implementation, ReadonlyArray<string>> = {
  typescript: ['benchmarks/workload.json', 'benchmarks/measure.ts', 'scripts/benchmark.ts', 'scripts/benchmark-matching.ts', 'scripts/benchmark-compare.ts', 'server/src', 'packages/contracts/src'],
  rust: ['benchmarks/workload.json', 'benchmarks/rust', 'scripts/benchmark-compare.ts'],
};

/** Builds the release binary; returns its path and the compiler version. */
function buildRust() {
  execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', CARGO_MANIFEST], { stdio: ['ignore', 'ignore', 'inherit'] });
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', CARGO_MANIFEST], { encoding: 'utf8' }));
  return { binary: join(metadata.target_directory, 'release', 'sanctum-bench'), rustc: execFileSync('rustc', ['-V'], { encoding: 'utf8' }).trim() };
}

function runChild(implementation: Implementation, job: Job, binary: string): Result[] {
  const [command, args] = implementation === 'typescript' ? [process.execPath, ['scripts/benchmark.ts', '--job', JSON.stringify(job)]] : [binary, [JSON.stringify(job)]];
  const output = execFileSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 2 ** 20, env: childEnv(process.env), stdio: ['ignore', 'pipe', 'inherit'] });
  return output.split('\n').filter(Boolean).map(line => JSON.parse(line) as Result);
}

/** An open-loop run is saturated when it completed less than 95% of the offered rate. */
export const saturated = (record: Pick<Result, 'metrics' | 'offered_load'>) => record.metrics['throughput']! < SATURATION_RATIO * record.offered_load.per_second;

/** RSS growth from the end of a 10% warm-up to the end of the run, against `bound`. */
export function longRunVerdict(series: ReadonlyArray<number>, bound = SOAK_GROWTH_BOUND_BYTES) {
  const baseline = series[Math.floor(series.length * 0.1)] ?? 0;
  const end = series.at(-1) ?? 0;
  return { baseline_bytes: baseline, peak_bytes: Math.max(...series), end_bytes: end, growth_bytes: end - baseline, bound_bytes: bound, within_bound: end - baseline <= bound };
}

const matchKey = (record: Result) => `${record.workload_id} ${record.phase} ${record.offered_load.per_second} x${record.offered_load.concurrency} ${record.parameters['mode']}`;

/** Invalid records, failed operations, and TypeScript/Rust pairs whose fixture hashes differ. */
export function matchProblems(records: ReadonlyArray<Result>): string[] {
  const fixtures = new Map<string, Set<string>>();
  records.forEach(record => fixtures.set(matchKey(record), (fixtures.get(matchKey(record)) ?? new Set()).add(record.fixture_sha256)));
  return [
    ...records.flatMap(record => validateResult(record).map(problem => `${record.implementation} ${record.workload_id}: ${problem}`)),
    ...records.filter(record => record.correctness.errors > 0).map(record => `${record.implementation} ${matchKey(record)}: ${record.correctness.errors} failed operations`),
    ...[...fixtures].filter(([, hashes]) => hashes.size > 1).map(([key]) => `${key}: TypeScript and Rust fixture SHA-256 differ`),
  ];
}

const base = (git_sha: string) => ({ git_sha, started_at: new Date().toISOString() });
/** Both drivers are one sequential stream, so `concurrency` is 1; the listener count a rate models is recorded separately. */
const pcmJob = (git_sha: string, frames: number, rate: number): Job => {
  const { fixture, parameters } = workload('pcm_ingest');
  return { ...base(git_sha), workload: 'pcm_ingest', frames, rate, concurrency: 1, seed: fixture.seed, samples_per_frame: Number(parameters['samples_per_frame']) };
};

/** Offered frame rates: the manifest's, then doublings of the largest (the manifest asks to sweep until saturation). */
export function sweepRates(offered: ReadonlyArray<number>, doublings: number): number[] {
  return [...offered, ...Array.from({ length: doublings }, (_, i) => offered.at(-1)! * 2 ** (i + 1))];
}

interface Options { readonly smoke: boolean; readonly soakSeconds: number }

class Run {
  readonly records: Result[] = [];
  readonly problems: string[] = [];
  /** Evidence lines printed after the table: database equality, saturation points, long-run growth. */
  readonly notes: string[] = [];
  readonly git_sha: string;
  readonly binary: string;

  constructor(git_sha: string, binary: string) {
    this.git_sha = git_sha;
    this.binary = binary;
  }

  job(implementation: Implementation, job: Job, mode: Mode): Result[] {
    const modelled = job.workload === 'pcm_ingest' && job.rate > 0 ? { equivalent_listeners_at_50fps: job.rate / 50 } : {};
    const records = runChild(implementation, job, this.binary).map(record => ({ ...record, parameters: { ...record.parameters, mode, ...modelled } }));
    this.records.push(...records);
    return records;
  }

  closedLoop(options: Options) {
    const cosine = workload('cosine_ranking');
    const jobs: Job[] = [
      pcmJob(this.git_sha, options.smoke ? 2_000 : 50_000, 0),
      { ...base(this.git_sha), workload: 'cosine_ranking', size: options.smoke ? 2_000 : 10_000, dimension: options.smoke ? 64 : Number(cosine.parameters['dimension']), queries: options.smoke ? 10 : 200, verify: 10, top_k: Number(cosine.parameters['top_k']), seed: cosine.fixture.seed },
    ];
    jobs.forEach(job => IMPLEMENTATIONS.forEach(implementation => this.job(implementation, job, 'closed_loop')));
  }

  sweep(options: Options) {
    const { parameters } = workload('pcm_ingest');
    const rates = sweepRates(parameters['offered_frames_per_second'] as number[], options.smoke ? 0 : 10);
    for (const implementation of IMPLEMENTATIONS) {
      let sustained = 0;
      for (const rate of rates) {
        const [record] = this.job(implementation, pcmJob(this.git_sha, Math.max(10, Math.round(rate * (options.smoke ? 0.25 : 2))), rate), 'open_loop_sweep');
        if (!saturated(record!)) sustained = rate;
        else {
          this.notes.push(`pcm_ingest ${implementation}: sustained ${sustained} frames/s; saturated at ${rate} offered (${record!.metrics['throughput']!.toFixed(0)} achieved)`);
          break;
        }
      }
      if (sustained === rates.at(-1)) this.notes.push(`pcm_ingest ${implementation}: sustained every offered rate up to ${sustained} frames/s; saturation not reached`);
    }
  }

  longRun(options: Options) {
    const rate = (workload('pcm_ingest').parameters['offered_frames_per_second'] as number[])[2]!;
    for (const implementation of IMPLEMENTATIONS) {
      const [record] = this.job(implementation, pcmJob(this.git_sha, rate * options.soakSeconds, rate), 'long_run');
      const verdict = longRunVerdict((record!.parameters['rss_series_bytes'] as number[] | undefined) ?? []);
      Object.assign(record!.parameters, { long_run: verdict });
      if (verdict.within_bound) this.notes.push(`${implementation} long run: ${options.soakSeconds} s at ${rate} frames/s, RSS growth ${(verdict.growth_bytes / 2 ** 20).toFixed(1)} MiB after warm-up (bound ${verdict.bound_bytes / 2 ** 20} MiB)`);
      else this.problems.push(`${implementation} long run: RSS grew ${verdict.growth_bytes} bytes after warm-up, bound ${verdict.bound_bytes}`);
    }
  }
}

const HOST = {
  host_class: 'uncontrolled: shared, loaded VPS, not the manifest reference host',
  cpu_model: cpus()[0]?.model ?? 'unknown',
  cores: cpus().length,
  ram_gib: Math.round(totalmem() / 2 ** 30),
  load_average_1m_at_start: loadavg()[0],
};

const ms = (value: number) => (value < 1 ? value.toFixed(3) : value.toFixed(1));
const ratio = (ts: number, rust: number) => (rust > 0 ? (ts / rust).toFixed(2) : 'n/a');

/** Markdown rows pairing each TypeScript record with its Rust twin at the same offered rate and concurrency. */
export function summaryRows(records: ReadonlyArray<Result>): string[] {
  const rust = new Map(records.filter(record => record.implementation === 'rust').map(record => [matchKey(record), record]));
  return records.filter(record => record.implementation === 'typescript' && rust.has(matchKey(record))).map(ts => {
    const [a, b] = [ts.metrics, rust.get(matchKey(ts))!.metrics] as const;
    const latency = (m: typeof a) => `${ms(m['latency_p50']!)} / ${ms(m['latency_p95']!)} / ${ms(m['latency_p99']!)}`;
    return `| \`${ts.workload_id}\` | ${ts.parameters['mode']} ${ts.phase} | ${ts.offered_load.concurrency} | ${ts.offered_load.per_second || '-'} | ${a['throughput']!.toFixed(1)} | ${b['throughput']!.toFixed(1)} | ${ratio(a['throughput']!, b['throughput']!)} | ${latency(a)} | ${latency(b)} | ${ratio(a['latency_p99']!, b['latency_p99']!)} | ${a['cpu']!.toFixed(0)} / ${b['cpu']!.toFixed(0)} | ${(a['rss']! / 2 ** 20).toFixed(0)} / ${(b['rss']! / 2 ** 20).toFixed(0)} |`;
  });
}

async function main(options: Options & { readonly out: string | undefined }) {
  const { binary, rustc } = buildRust();
  const run = new Run(gitSha(), binary);
  const runtime: Record<Implementation, string> = { typescript: `node ${process.version} (V8 ${process.versions.v8})`, rust: `${rustc}, cargo --release (opt-level 3, lto thin, codegen-units 1)` };
  run.closedLoop(options);
  console.error('archive_streaming, transcript_ingest, context_read_write: unrun (the Rust reference has no SQLite driver; run them with scripts/benchmark.ts)');
  run.sweep(options);
  run.longRun(options);
  const sources = { typescript: sourceSha(SOURCES.typescript), rust: sourceSha(SOURCES.rust) };
  // The Rust binary does not read the manifest: every record names the manifest reference host, as `validateResult` requires.
  const records = run.records.map(record => ({ ...record, host: manifest.reference_hardware.name, parameters: { ...record.parameters, harness: { ...HOST, runtime: runtime[record.implementation], source_sha256: sources[record.implementation] } } }));
  if (options.out) writeFileSync(options.out, records.map(record => `${JSON.stringify(record)}\n`).join(''));
  console.log('| Workload | Mode | Concurrency | Offered/s | TS ops/s | Rust ops/s | TS/Rust ops | TS p50 / p95 / p99 ms | Rust p50 / p95 / p99 ms | TS/Rust p99 | CPU % TS / Rust | RSS MiB TS / Rust |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  summaryRows(records).forEach(row => console.log(row));
  console.log();
  run.notes.forEach(note => console.log(`- ${note}`));
  const problems = [...matchProblems(records), ...run.problems];
  problems.forEach(problem => console.error(problem));
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { smoke: { type: 'boolean', default: false }, out: { type: 'string' }, 'soak-seconds': { type: 'string' } } });
  const soakSeconds = Number(values['soak-seconds'] ?? (values.smoke ? 5 : 300));
  await main({ smoke: values.smoke, out: values.out, soakSeconds });
}
