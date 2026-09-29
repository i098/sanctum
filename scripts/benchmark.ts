/**
 * Section 04 benchmark harness (T26). Runs the TypeScript side of every workload in
 * benchmarks/workload.json through the real application code and prints one validated result
 * record per workload and phase as JSON lines:
 *
 * - `pcm_ingest`: `decodePcmFrame` validation plus dispatch into a bounded live queue.
 * - `archive_streaming`: `putChunk` (WAV shape, SHA-256, manifest claim, object write, commit).
 * - `transcript_ingest`: `publishFinalWindow` (segments, coverage and meeting hooks).
 * - `context_read_write`: `getContextSnapshot` and `addContextItem` at the manifest's 9:1 mix.
 * - `cosine_ranking`: scripts/benchmark-matching.ts.
 *
 * The MySQL workloads need `--mysql-url` (an account allowed to create and drop a database);
 * without it they are reported as unrun. Every record is `verified: false`: no controlled
 * benchmark host exists, so parity and absolute budgets stay unclaimed. The matched Rust
 * reference (benchmarks/rust) runs through scripts/benchmark-compare.ts.
 *
 * Usage: node scripts/benchmark.ts [--smoke] [--mysql-url mysql://...] [--out benchmarks/results/x.jsonl]
 *        node scripts/benchmark.ts --job '<job json>' (one matched job; see scripts/benchmark-compare.ts)
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { type AccessScope, CaptureEpochId, ListenerId, MeetingId, PrincipalId, RecordingChunkId, RecordingChunkManifest, TranscriptSegmentId, WorkspaceId, decodePcmFrame, encodePcmFrame } from '@sanctum/contracts';
import { SqlClient } from '@effect/sql';
import { Effect, Either, Layer, ManagedRuntime, Redacted, Schema } from 'effect';
import { createConnection } from 'mysql2/promise';
import { type BenchmarkRecord, gitSha, sample, seededRandom, toRecord } from '../benchmarks/measure.ts';
import { validateResult } from '../benchmarks/result-format.ts';
import { runCosineBenchmark } from './benchmark-matching.ts';
import { addContextItem, getContextSnapshot } from '../server/src/context.ts';
import { dbLayer } from '../server/src/db.ts';
import { loadMigrations, migrate } from '../server/src/migrate.ts';
import { ObjectStore } from '../server/src/providers/object-store.ts';
import { putChunk } from '../server/src/recordings.ts';
import { publishFinalWindow } from '../server/src/transcripts.ts';

interface Workload { id: string; fixture: { seed: number }; parameters: Record<string, number | number[] | string | boolean> }
const manifest: { workloads: Workload[] } = JSON.parse(readFileSync(new URL('../benchmarks/workload.json', import.meta.url), 'utf8'));
const workload = (id: string) => manifest.workloads.find(entry => entry.id === id)!;

const started_at = new Date().toISOString();
const sha = (...parts: Uint8Array[]) => parts.reduce((hash, part) => hash.update(part), createHash('sha256')).digest('hex');

/** `pcm16-frames-v1`: seeded noise frames; dispatch = bounded queue drained every 32 frames. A `rate` offers frames open-loop from `concurrency` listeners. */
async function pcmIngest(frames: number, git_sha: string, rate = 0, concurrency = 1): Promise<BenchmarkRecord[]> {
  const { fixture, parameters } = workload('pcm_ingest');
  const perFrame = Number(parameters['samples_per_frame']);
  const next = seededRandom(fixture.seed);
  const encoded = Array.from({ length: 64 }, (_, sequence) =>
    encodePcmFrame({ track: 0, sequence, sample_start: sequence * perFrame, sample_count: perFrame }, Int16Array.from({ length: perFrame }, () => Math.round(next() * 32_000))));
  const capacity = 256;
  const queue: Int16Array[] = [];
  let errors = 0;
  let dropped = 0;
  const run = await sample(frames, async i => {
    const decoded = decodePcmFrame(encoded[i % encoded.length]!);
    if ('error' in decoded) errors++;
    else if (queue.length >= capacity) dropped += decoded.frame.sample_count;
    else queue.push(decoded.frame.samples);
    if (i % 32 === 31) {
      queue.length = 0;
      await yieldToLoop();
    }
  }, rate);
  const parametersUsed = { frames, samples_per_frame: perFrame, queue_capacity_frames: capacity, scope: 'frame validation and bounded dispatch; socket, auth and ASR excluded' };
  return [toRecord({ workload_id: 'pcm_ingest', phase: 'steady', sample: run, fixture_sha256: sha(...encoded), git_sha, started_at, concurrency, rate, errors, checked: frames, dropped_samples: dropped, parameters: parametersUsed })];
}

/** In-memory object store with the production interface: the archive workload times Sanctum's own path. */
const memoryStore = Layer.sync(ObjectStore, () => {
  const objects = new Map<string, { bytes: Uint8Array; sha256: string }>();
  const describe = (key: string) => (objects.has(key) ? { key, byte_length: objects.get(key)!.bytes.byteLength, sha256: objects.get(key)!.sha256 } : null);
  return {
    put: (key, body, meta) => Effect.sync(() => (objects.set(key, { bytes: body, sha256: meta.sha256 }), describe(key)!)),
    head: key => Effect.sync(() => describe(key)),
    get: key => Effect.sync(() => objects.get(key)?.bytes ?? new Uint8Array()),
    presignGet: key => Effect.succeed(`memory://${key}`),
  };
});

type BenchRuntime = ManagedRuntime.ManagedRuntime<SqlClient.SqlClient | ObjectStore, unknown>;

interface Attached { runtime: BenchRuntime; owner: AccessScope; device: AccessScope; listener: ListenerId; epoch: CaptureEpochId }
interface Fixture extends Attached { drop: () => Promise<void> }

/** IDs of the rows `createDatabase` seeds; the Rust reference attaches to the same rows. */
export interface FixtureIds { workspace: WorkspaceId; owner: PrincipalId; device: PrincipalId; listener: ListenerId; epoch: CaptureEpochId }

const mysqlOptions = (url: string) => {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 3306), database: parsed.pathname.slice(1), username: decodeURIComponent(parsed.username), password: Redacted.make(decodeURIComponent(parsed.password)), maxConnections: 8, queueLimit: 100 };
};

const access = (workspace_id: WorkspaceId, id: PrincipalId, kind: 'human' | 'device', scopes: AccessScope['scopes']): AccessScope => ({
  workspace_id,
  principal: { id, kind, display_name: kind },
  role: kind === 'human' ? 'owner' : 'device',
  scopes,
  meetings: { kind: 'accessible' },
  permission_revision: 1,
});

/** A fresh `sanctum_bench_*` database, migrated and seeded with one workspace, owner, device, listener and 48 kHz epoch. */
export async function createDatabase(url: string): Promise<{ url: string; ids: FixtureIds; drop: () => Promise<void> }> {
  const name = `sanctum_bench_${randomBytes(6).toString('hex')}`;
  const admin = await createConnection(url);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const migrator = ManagedRuntime.make(dbLayer(mysqlOptions(`${url}/${name}`)));
  await migrator.runPromise(migrate(loadMigrations()));
  await migrator.dispose();
  const [workspace, owner, device, listener, epoch] = [WorkspaceId.make(randomUUID()), PrincipalId.make(randomUUID()), PrincipalId.make(randomUUID()), ListenerId.make(randomUUID()), CaptureEpochId.make(randomUUID())];
  const seed = await createConnection(`${url}/${name}`);
  await seed.query(`INSERT INTO workspaces (id, name, timezone, created_at) VALUES (?, 'Bench', 'UTC', UTC_TIMESTAMP(6))`, [workspace]);
  await seed.query(`INSERT INTO principals (id, kind, display_name, created_at) VALUES (?, 'human', 'Owner', UTC_TIMESTAMP(6)), (?, 'device', 'Room', UTC_TIMESTAMP(6))`, [owner, device]);
  await seed.query(`INSERT INTO workspace_members (workspace_id, principal_id, role, created_at) VALUES (?, ?, 'owner', UTC_TIMESTAMP(6)), (?, ?, 'device', UTC_TIMESTAMP(6))`, [workspace, owner, workspace, device]);
  await seed.query(`INSERT INTO listeners (id, workspace_id, principal_id, name, mode, state, lease_generation, current_epoch_id, capabilities, created_at) VALUES (?, ?, ?, 'Room', 'room', 'listening', 1, ?, '{}', UTC_TIMESTAMP(6))`, [listener, workspace, device, epoch]);
  await seed.query(`INSERT INTO capture_epochs (id, workspace_id, listener_id, lease_generation, sample_rate, channels, encoding, sample_start, captured_at, timezone, start_reason, started_at, live_sample_end)
        VALUES (?, ?, ?, 1, 48000, 1, 'pcm_s16le', 0, '2026-09-29 09:00:00', 'UTC', 'start', UTC_TIMESTAMP(6), 0)`, [epoch, workspace, listener]);
  await seed.end();
  const drop = async () => {
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  };
  return { url: `${url}/${name}`, ids: { workspace, owner, device, listener, epoch }, drop };
}

/** The application runtime (real MySQL pool, in-memory object store) over a database `createDatabase` seeded. */
function attachDatabase(url: string, ids: FixtureIds): Attached {
  const runtime = ManagedRuntime.make(Layer.merge(dbLayer(mysqlOptions(url)), memoryStore));
  return { runtime, owner: access(ids.workspace, ids.owner, 'human', ['context:read', 'context:write', 'recordings:read']), device: access(ids.workspace, ids.device, 'device', ['capture:ingest']), listener: ids.listener, epoch: ids.epoch };
}

export async function database(url: string): Promise<Fixture> {
  const created = await createDatabase(url);
  const attached = attachDatabase(created.url, created.ids);
  return { ...attached, drop: async () => (await attached.runtime.dispose(), await created.drop()) };
}

/** Runs one operation and reports whether it failed (failures are counted, never thrown). */
const failures = async <A, E>(runtime: BenchRuntime, effect: Effect.Effect<A, E, SqlClient.SqlClient | ObjectStore>) => Either.isLeft(await runtime.runPromise(Effect.either(effect)));

const decodeManifest = Schema.decodeUnknownSync(RecordingChunkManifest);

/** Mono PCM16 WAV: the canonical 44-byte header followed by little-endian samples. */
function wav(samples: Int16Array, rate: number): Uint8Array {
  const body = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(body.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, i) => view.setInt16(44 + i * 2, value, true));
  return body;
}

/** `wav-chunks-v1`: seeded PCM16 WAV bodies of `seconds` each, sent through `putChunk`. */
async function archiveStreaming(db: Attached, chunks: number, seconds: number, git_sha: string): Promise<BenchmarkRecord[]> {
  const { fixture } = workload('archive_streaming');
  const next = seededRandom(fixture.seed);
  const samples = 48_000 * seconds;
  const body = wav(Int16Array.from({ length: samples }, () => Math.round(next() * 32_000)), 48_000);
  const bodySha = sha(body);
  let errors = 0;
  const run = await sample(chunks, async i => {
    const chunk_id = RecordingChunkId.make(randomUUID());
    const manifest = decodeManifest({ chunk_id, listener_id: db.listener, epoch_id: db.epoch, track: 0, sequence: i, sample_start: i * samples, sample_count: samples, sample_rate: 48_000, captured_at: '2026-09-29T09:00:00Z', byte_length: body.byteLength, sha256: bodySha });
    if (await failures(db.runtime, putChunk(db.device, db.listener, chunk_id, manifest, body))) errors++;
  });
  return [toRecord({ workload_id: 'archive_streaming', phase: 'steady', sample: run, fixture_sha256: bodySha, git_sha, started_at, concurrency: 1, errors, checked: chunks, dropped_samples: 0, parameters: { chunks, chunk_seconds: seconds, object_store: 'in-memory stub', scope: 'putChunk end to end against MySQL' } })];
}

/** `transcript-segments-v1`: 5-second final segments on one epoch through `publishFinalWindow`. */
async function transcriptIngest(db: Attached, segments: number, git_sha: string): Promise<BenchmarkRecord[]> {
  const span = 48_000 * 5;
  const text = (i: number) => `Segment ${i}: ${'discussion of the pilot rollout '.repeat(8)}`.slice(0, 240);
  let errors = 0;
  const run = await sample(segments, async i => {
    const window = { sample_start: i * span, sample_end: (i + 1) * span };
    const effect = publishFinalWindow({
      workspace_id: db.owner.workspace_id, epoch_id: db.epoch, track: 0, window, segments: [{ ...window, text: text(i), confidence: 0.9, speaker_label: null }],
      origin: 'live', provider: 'bench', model: 'bench', provider_connection_id: null, listener_id: db.listener, capture_group_id: null
    });
    if (await failures(db.runtime, effect)) errors++;
  });
  return [toRecord({
    workload_id: 'transcript_ingest', phase: 'steady', sample: run, fixture_sha256: sha(new TextEncoder().encode(Array.from({ length: segments }, (_, i) => text(i)).join('\n'))), git_sha, started_at,
    concurrency: 1, errors, checked: segments, dropped_samples: 0, parameters: { segments, segment_seconds: 5, segment_text_bytes: 240, scope: 'publishFinalWindow including meeting hooks' }
  })];
}

/** `context-items-v1`: 9 snapshot reads per write on the meetings transcript ingest created. */
async function contextReadWrite(db: Attached, operations: number, git_sha: string): Promise<BenchmarkRecord[]> {
  const cited = await db.runtime.runPromise(citedSegments(db.owner));
  if (cited.length === 0) throw new Error('context_read_write needs transcript_ingest to create meetings first');
  let errors = 0;
  const run = await sample(operations, async i => {
    const target = cited[i % cited.length]!;
    const read = getContextSnapshot(db.owner, target.meeting_id);
    if (i % 10 !== 9) {
      if (await failures(db.runtime, read)) errors++;
      return;
    }
    const write = Effect.flatMap(read, snapshot =>
      addContextItem(db.owner, { meeting_id: target.meeting_id, expected_revision: snapshot.revision, kind: 'decision', text: `Decision ${i}`, sources: [{ segment_id: target.segment_id, start_ms: 0, end_ms: 1_000 }], idempotency_key: `bench-${i}` }));
    if (await failures(db.runtime, write)) errors++;
  });
  return [toRecord({
    workload_id: 'context_read_write', phase: 'steady', sample: run, fixture_sha256: sha(new TextEncoder().encode(cited.map(row => row.sample_start).join('\n'))), git_sha, started_at,
    concurrency: 1, errors, checked: operations, dropped_samples: 0, parameters: { operations, meetings: new Set(cited.map(row => row.meeting_id)).size, read_write_ratio: 9 }
  })];
}

/**
 * The earliest final segment of each meeting (meetings in start order), so the TypeScript and
 * Rust runs cite the same source; grants the owner explicit access (detected meetings start restricted).
 */
const citedSegments = (owner: AccessScope) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ meeting_id: string; segment_id: string; sample_start: string }>`SELECT r.meeting_id, s.id AS segment_id, s.sample_start FROM transcript_segments s
            JOIN meeting_ranges r ON r.epoch_id = s.epoch_id AND s.sample_start >= r.sample_start AND s.sample_start < r.sample_end
            JOIN meetings m ON m.id = r.meeting_id AND m.boundary_revision = r.boundary_revision
            ORDER BY m.started_at, r.meeting_id, s.sample_start`;
    yield* sql`INSERT IGNORE INTO meeting_access (workspace_id, meeting_id, principal_id, access, granted_by, created_at)
            SELECT workspace_id, id, ${owner.principal.id}, 'owner', ${owner.principal.id}, UTC_TIMESTAMP(6) FROM meetings WHERE workspace_id = ${owner.workspace_id}`;
    return rows
      .filter((row, i) => row.meeting_id !== rows[i - 1]?.meeting_id)
      .map(row => ({ meeting_id: MeetingId.make(row.meeting_id), segment_id: TranscriptSegmentId.make(row.segment_id), sample_start: String(row.sample_start) }));
  });

/** Runs every workload at `smoke` or manifest-derived scale; returns validated records and whether all were correct. */
export async function runBenchmarks(options: { readonly smoke: boolean; readonly mysqlUrl: string | undefined }, git_sha = gitSha()) {
  const scale = options.smoke ? { frames: 2_000, chunks: 3, seconds: 2, segments: 40, operations: 100 } : { frames: 50_000, chunks: 24, seconds: 30, segments: 2_000, operations: 5_000 };
  const cosine = workload('cosine_ranking').parameters;
  const records: BenchmarkRecord[] = [...(await pcmIngest(scale.frames, git_sha))];
  records.push(...(await runCosineBenchmark({ size: options.smoke ? 2_000 : 10_000, dimension: options.smoke ? 64 : Number(cosine['dimension']), queries: options.smoke ? 10 : 200, verify: 10, topK: 10, seed: workload('cosine_ranking').fixture.seed }, git_sha)));
  const unrun: string[] = [];
  if (options.mysqlUrl === undefined) unrun.push('archive_streaming', 'transcript_ingest', 'context_read_write');
  else {
    const db = await database(options.mysqlUrl);
    try {
      records.push(...(await archiveStreaming(db, scale.chunks, scale.seconds, git_sha)));
      records.push(...(await transcriptIngest(db, scale.segments, git_sha)));
      records.push(...(await contextReadWrite(db, scale.operations, git_sha)));
    } finally {
      await db.drop();
    }
  }
  const problems = records.flatMap(record => [...validateResult(record), ...(record.correctness.errors > 0 ? [`${record.workload_id}: ${record.correctness.errors} failed operations`] : [])]);
  return { records, unrun, problems };
}

/**
 * One job from scripts/benchmark-compare.ts. benchmarks/rust reads the same JSON; this side takes
 * fixture seeds and frame sizes from the manifest the runner built the job from.
 */
export type Job = { readonly git_sha: string; readonly started_at: string } & (
  | { readonly workload: 'pcm_ingest'; readonly frames: number; readonly rate: number; readonly concurrency: number; readonly seed: number; readonly samples_per_frame: number }
  | { readonly workload: 'cosine_ranking'; readonly size: number; readonly dimension: number; readonly queries: number; readonly verify: number; readonly top_k: number; readonly seed: number }
  | { readonly workload: 'database'; readonly database_url: string; readonly ids: FixtureIds; readonly archive_seed: number; readonly chunks: number; readonly chunk_seconds: number; readonly segments: number; readonly operations: number }
);

export async function runJob(job: Job): Promise<BenchmarkRecord[]> {
  if (job.workload === 'pcm_ingest') return pcmIngest(job.frames, job.git_sha, job.rate, job.concurrency);
  if (job.workload === 'cosine_ranking') return runCosineBenchmark({ size: job.size, dimension: job.dimension, queries: job.queries, verify: job.verify, topK: job.top_k, seed: job.seed }, job.git_sha);
  const db = attachDatabase(job.database_url, job.ids);
  try {
    // context_read_write cites the meetings transcript_ingest creates, so the order is fixed.
    return [...(await archiveStreaming(db, job.chunks, job.chunk_seconds, job.git_sha)), ...(await transcriptIngest(db, job.segments, job.git_sha)), ...(await contextReadWrite(db, job.operations, job.git_sha))];
  } finally {
    await db.runtime.dispose();
  }
}

if (import.meta.main && process.argv[2] === '--job') {
  for (const record of await runJob(JSON.parse(process.argv[3]!))) console.log(JSON.stringify(record));
} else if (import.meta.main) {
  const { values } = parseArgs({ options: { smoke: { type: 'boolean', default: false }, 'mysql-url': { type: 'string' }, out: { type: 'string' } } });
  const { records, unrun, problems } = await runBenchmarks({ smoke: values.smoke, mysqlUrl: values['mysql-url'] ?? process.env['SANCTUM_TEST_MYSQL_URL'] });
  for (const record of records) {
    const line = JSON.stringify(record);
    console.log(line);
    if (values.out) appendFileSync(values.out, `${line}\n`);
    const m = record.metrics;
    console.error(`${record.workload_id} ${record.phase}: ${m.throughput.toFixed(1)} ops/s, p50 ${m.latency_p50.toFixed(3)} ms, p99 ${m.latency_p99.toFixed(3)} ms, rss ${(m.rss / 2 ** 20).toFixed(0)} MiB, errors ${record.correctness.errors}`);
  }
  unrun.forEach(id => console.error(`${id}: unrun (no --mysql-url or SANCTUM_TEST_MYSQL_URL)`));
  problems.forEach(problem => console.error(problem));
  if (problems.length > 0) process.exitCode = 1;
}
