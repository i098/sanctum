/**
 * Benchmark workload manifest and per-run result record (tasks/plan.md section 04), as Effect
 * Schemas. Validators return error lists; an empty list means valid.
 */
import { readFileSync } from 'node:fs';
import { Either, ParseResult, Schema } from 'effect';

const WORKLOAD_IDS = ['pcm_ingest', 'transcript_ingest', 'context_read_write', 'archive_streaming', 'cosine_ranking'] as const;
const METRICS = ['throughput', 'latency_p50', 'latency_p95', 'latency_p99', 'error_rate', 'dropped_samples', 'cpu', 'rss', 'heap', 'external', 'gc_ms', 'event_loop_delay_p99'] as const;

const Text = Schema.String.pipe(Schema.minLength(1));
const Amount = Schema.Number.pipe(Schema.finite(), Schema.nonNegative());
const Count = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
const Hex = (length: number) => Schema.String.pipe(Schema.pattern(new RegExp(`^[0-9a-f]{${length}}$`)));
/** The members of `values`, each exactly once, in any order. */
const Exactly = <const V extends readonly string[]>(values: V, label: string) =>
  Schema.Array(Schema.Literal(...values)).pipe(
    Schema.filter(items => (items.length === values.length && values.every(value => items.includes(value))) || `${label} must list exactly ${values.join(', ')}`),
  );

const Hardware = Schema.Struct({
  status: Schema.Literal('unverified', 'verified'),
  name: Schema.NullOr(Text),
  cpu_model: Schema.NullOr(Text),
  cores: Schema.NullOr(Count),
  ram_gb: Schema.NullOr(Amount),
  os: Schema.NullOr(Text),
});

// Plan tolerance is a floor: a gate may be stricter than 90% throughput / 110% latency, never looser.
const Parity = Schema.Struct({
  min_throughput_ratio: Schema.Number.pipe(Schema.between(0.9, 1)),
  max_latency_ratio_p95: Schema.Number.pipe(Schema.between(1, 1.1)),
  max_latency_ratio_p99: Schema.Number.pipe(Schema.between(1, 1.1)),
  status: Schema.Literal('unverified', 'passed', 'failed'),
});

const Workload = Schema.Struct({
  id: Schema.Literal(...WORKLOAD_IDS),
  description: Text,
  fixture: Schema.Struct({ generator: Text, seed: Count }),
  parameters: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  metrics: Exactly(METRICS, 'metrics'),
  durability: Text,
  parity_gate: Parity,
});

const Manifest = Schema.Struct({
  schema_version: Schema.Literal(1),
  reference_hardware: Hardware,
  runtime: Schema.Struct({ node_engine: Text, node: Schema.NullOr(Text), v8: Schema.NullOr(Text), rust_toolchain: Schema.NullOr(Text), rust_release_flags: Schema.NullOr(Text) }),
  limits: Schema.Struct({ cpu_cores: Schema.NullOr(Count), memory_mb: Schema.NullOr(Count) }),
  workloads: Schema.Array(Workload),
}).pipe(
  Schema.filter(manifest => {
    const hardware = manifest.reference_hardware;
    const verified = hardware.status === 'verified';
    const ids = manifest.workloads.map(workload => workload.id);
    return [
      (ids.length === WORKLOAD_IDS.length && WORKLOAD_IDS.every(id => ids.includes(id))) || `workloads ids must list exactly ${WORKLOAD_IDS.join(', ')}`,
      !verified || Object.values(hardware).every(value => value !== null) || 'reference_hardware must be complete when verified',
      verified || manifest.workloads.every(workload => workload.parity_gate.status === 'unverified') || 'parity gates stay unverified while reference hardware is unverified',
    ].filter((issue): issue is string => typeof issue === 'string');
  }),
);

const Result = Schema.Struct({
  workload_id: Schema.Literal(...WORKLOAD_IDS),
  implementation: Schema.Literal('typescript', 'rust'),
  git_sha: Hex(40),
  fixture_sha256: Hex(64),
  started_at: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/), Schema.filter(value => !Number.isNaN(Date.parse(value)))),
  host: Schema.NullOr(Text),
  phase: Schema.Literal('cold', 'steady'),
  repetitions: Schema.Number.pipe(Schema.int(), Schema.positive()),
  offered_load: Schema.Struct({ per_second: Amount, concurrency: Count }),
  metrics: Schema.Struct(Object.fromEntries(METRICS.map(name => [name, Amount])) as Record<(typeof METRICS)[number], typeof Amount>),
  correctness: Schema.Struct({ errors: Count, dropped_samples: Count }),
  verified: Schema.Boolean,
});

const readManifest = (): unknown => JSON.parse(readFileSync(new URL('./workload.json', import.meta.url), 'utf8'));

/** Every issue with its path, e.g. `workloads[0].parity_gate.min_throughput_ratio: ...`. */
const issues = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Either.match(Schema.decodeUnknownEither(schema, { errors: 'all' })(value), {
    onLeft: error => ParseResult.ArrayFormatter.formatErrorSync(error).map(issue => `${issue.path.map(key => (typeof key === 'number' ? `[${key}]` : `.${String(key)}`)).join('').replace(/^\./, '')}: ${issue.message}`),
    onRight: () => [],
  });

export function validateManifest(value: unknown = readManifest()): string[] {
  return issues(Manifest, value);
}

export function validateResult(value: unknown, manifest: unknown = readManifest()): string[] {
  const errors = [...validateManifest(manifest), ...issues(Result, value)];
  if (errors.length > 0) return errors;
  const hardware = Schema.decodeUnknownSync(Manifest)(manifest).reference_hardware;
  const result = Schema.decodeUnknownSync(Result)(value);
  return [
    ...(result.host === hardware.name ? [] : ['result.host must equal manifest reference_hardware.name']),
    ...(!result.verified || hardware.status === 'verified' ? [] : ['result.verified requires verified manifest reference hardware']),
  ];
}
