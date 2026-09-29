/**
 * Benchmark workload manifest and per-run result record (tasks/plan.md section 04).
 * Validators return error lists; an empty list means valid. Plain code, no schema dependency.
 */
import { readFileSync } from 'node:fs';

const WORKLOAD_IDS = ['pcm_ingest', 'transcript_ingest', 'context_read_write', 'archive_streaming', 'cosine_ranking'] as const;
const METRICS = ['throughput', 'latency_p50', 'latency_p95', 'latency_p99', 'error_rate', 'dropped_samples', 'cpu', 'rss', 'heap', 'external', 'gc_ms', 'event_loop_delay_p99'] as const;
const HARDWARE_STATUSES = ['unverified', 'verified'] as const;
const GATE_STATUSES = ['unverified', 'passed', 'failed'] as const;

type Metric = (typeof METRICS)[number];

interface ReferenceHardware {
  status: (typeof HARDWARE_STATUSES)[number];
  name: string | null;
  cpu_model: string | null;
  cores: number | null;
  ram_gb: number | null;
  os: string | null;
}

interface ParityGate {
  min_throughput_ratio: number;
  max_latency_ratio_p95: number;
  max_latency_ratio_p99: number;
  status: (typeof GATE_STATUSES)[number];
}

interface Workload {
  id: (typeof WORKLOAD_IDS)[number];
  description: string;
  fixture: { generator: string; seed: number };
  parameters: Record<string, unknown>;
  metrics: Metric[];
  durability: string;
  parity_gate: ParityGate;
}

interface WorkloadManifest {
  schema_version: 1;
  reference_hardware: ReferenceHardware;
  runtime: { node_engine: string; node: string | null; v8: string | null; rust_toolchain: string | null; rust_release_flags: string | null };
  limits: { cpu_cores: number | null; memory_mb: number | null };
  workloads: Workload[];
}

interface BenchmarkResult {
  workload_id: string;
  implementation: 'typescript' | 'rust';
  git_sha: string;
  fixture_sha256: string;
  started_at: string;
  host: string | null;
  phase: 'cold' | 'steady';
  repetitions: number;
  offered_load: { per_second: number; concurrency: number };
  metrics: Record<Metric, number>;
  correctness: { errors: number; dropped_samples: number };
  verified: boolean;
}

type Check = (value: unknown, path: string) => string[];
type Fields<T> = { [K in keyof T]-?: Check };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (ok: boolean, message: string) => (ok ? [] : [message]);
const sameSet = (actual: readonly unknown[], expected: readonly unknown[]) => actual.length === expected.length && expected.every(item => actual.includes(item));

const text: Check = (v, p) => fail(typeof v === 'string' && v.length > 0, `${p} must be a non-empty string`);
const amount: Check = (v, p) => fail(typeof v === 'number' && Number.isFinite(v) && v >= 0, `${p} must be a non-negative number`);
const count: Check = (v, p) => fail(Number.isInteger(v) && (v as number) >= 0, `${p} must be a non-negative integer`);
const flag: Check = (v, p) => fail(typeof v === 'boolean', `${p} must be a boolean`);
const object: Check = (v, p) => fail(isRecord(v), `${p} must be an object`);
const timestamp: Check = (v, p) => fail(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) && !Number.isNaN(Date.parse(v)), `${p} must be an ISO-8601 UTC timestamp`);
const hex = (length: number): Check => (v, p) => fail(typeof v === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(v), `${p} must be ${length} lowercase hex characters`);
const nullable = (check: Check): Check => (v, p) => (v === null ? [] : check(v, p));
const oneOf = (values: readonly unknown[]): Check => (v, p) => fail(values.includes(v), `${p} must be one of ${values.join(', ')}`);
const range = (min: number, max: number): Check => (v, p) => fail(typeof v === 'number' && v >= min && v <= max, `${p} must be between ${min} and ${max}`);
const exactly = (values: readonly unknown[]): Check => (v, p) => fail(Array.isArray(v) && sameSet(v, values), `${p} must list exactly ${values.join(', ')}`);
const list = (check: Check): Check => (v, p) => (Array.isArray(v) ? v.flatMap((item, i) => check(item, `${p}[${i}]`)) : [`${p} must be an array`]);
const shape = (fields: Record<string, Check>): Check => (v, p) =>
  isRecord(v) ? Object.entries(fields).flatMap(([key, check]) => check(v[key], `${p}.${key}`)) : [`${p} must be an object`];

const HARDWARE: Fields<ReferenceHardware> = {
  status: oneOf(HARDWARE_STATUSES), name: nullable(text), cpu_model: nullable(text), cores: nullable(count), ram_gb: nullable(amount), os: nullable(text),
};

// Plan tolerance is a floor: a gate may be stricter than 90% throughput / 110% latency, never looser.
const PARITY: Fields<ParityGate> = {
  min_throughput_ratio: range(0.9, 1), max_latency_ratio_p95: range(1, 1.1), max_latency_ratio_p99: range(1, 1.1), status: oneOf(GATE_STATUSES),
};

const WORKLOAD: Fields<Workload> = {
  id: oneOf(WORKLOAD_IDS), description: text, fixture: shape({ generator: text, seed: count }), parameters: object,
  metrics: exactly(METRICS), durability: text, parity_gate: shape(PARITY),
};

const MANIFEST: Fields<WorkloadManifest> = {
  schema_version: oneOf([1]),
  reference_hardware: shape(HARDWARE),
  runtime: shape({ node_engine: text, node: nullable(text), v8: nullable(text), rust_toolchain: nullable(text), rust_release_flags: nullable(text) }),
  limits: shape({ cpu_cores: nullable(count), memory_mb: nullable(count) }),
  workloads: list(shape(WORKLOAD)),
};

const RESULT: Fields<BenchmarkResult> = {
  workload_id: oneOf(WORKLOAD_IDS), implementation: oneOf(['typescript', 'rust']), git_sha: hex(40), fixture_sha256: hex(64),
  started_at: timestamp, host: nullable(text), phase: oneOf(['cold', 'steady']), repetitions: range(1, Number.MAX_SAFE_INTEGER),
  offered_load: shape({ per_second: amount, concurrency: count }), metrics: shape(Object.fromEntries(METRICS.map(name => [name, amount]))),
  correctness: shape({ errors: count, dropped_samples: count }), verified: flag,
};

const readManifest = (): unknown => JSON.parse(readFileSync(new URL('./workload.json', import.meta.url), 'utf8'));

function manifestRules(manifest: WorkloadManifest): string[] {
  const hardware = manifest.reference_hardware;
  const verified = hardware.status === 'verified';
  return [
    ...exactly(WORKLOAD_IDS)(manifest.workloads.map(workload => workload.id), 'manifest.workloads ids'),
    ...fail(!verified || Object.values(hardware).every(value => value !== null), 'manifest.reference_hardware must be complete when verified'),
    ...fail(verified || manifest.workloads.every(workload => workload.parity_gate.status === 'unverified'), 'parity gates stay unverified while reference hardware is unverified'),
  ];
}

function resultRules(result: BenchmarkResult, manifest: WorkloadManifest): string[] {
  const hardware = manifest.reference_hardware;
  return [
    ...fail(result.host === hardware.name, 'result.host must equal manifest reference_hardware.name'),
    ...fail(!result.verified || hardware.status === 'verified', 'result.verified requires verified manifest reference hardware'),
  ];
}

export function validateManifest(value: unknown = readManifest()): string[] {
  const errors = shape(MANIFEST)(value, 'manifest');
  return errors.length > 0 ? errors : manifestRules(value as WorkloadManifest);
}

export function validateResult(value: unknown, manifest: unknown = readManifest()): string[] {
  const errors = [...validateManifest(manifest), ...shape(RESULT)(value, 'result')];
  return errors.length > 0 ? errors : resultRules(value as BenchmarkResult, manifest as WorkloadManifest);
}
