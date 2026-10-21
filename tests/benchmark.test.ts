import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sample, toRecord } from '../benchmarks/measure.ts';
import { createDatabase, runBenchmarks, runJob, type FixtureIds, type Job } from '../scripts/benchmark.ts';

test('smoke benchmarks emit valid unverified records with correct results and name unrun MySQL workloads', async () => {
  const { records, unrun, problems } = await runBenchmarks({ smoke: true, mysqlUrl: undefined }, 'd'.repeat(40));
  assert.deepEqual(problems, []);
  assert.deepEqual(records.map(record => `${record.workload_id}:${record.phase}`), ['pcm_ingest:steady', 'cosine_ranking:cold', 'cosine_ranking:steady']);
  assert(records.every(record => record.verified === false && record.correctness.errors === 0 && record.fixture_sha256.length === 64));
  assert.deepEqual(unrun, ['archive_streaming', 'transcript_ingest', 'context_read_write']);
});

// A serial runner never lets the second client arrive, so the barrier never opens and the test timeout fails it.
test('every client is in flight at once, and each client runs its operations in order', { timeout: 10_000 }, async () => {
  const clients = 3;
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => (release = resolve));
  const order: number[][] = Array.from({ length: clients }, () => []);
  const run = await sample(4, async (i, client) => {
    if (i === 0 && ++arrived === clients) release();
    if (i === 0) await barrier;
    order[client]!.push(i);
  }, 0, clients);
  assert.deepEqual(order, Array.from({ length: clients }, () => [0, 1, 2, 3]));
  assert.equal(run.latencies.length, clients * 4);
});

test('a failed client is reported by index after the others settle, and yields no sample', async () => {
  const finished: number[] = [];
  await assert.rejects(
    sample(3, async (i, client) => {
      if (client === 1 && i === 1) throw new Error('connection lost');
      if (i === 2) finished.push(client);
    }, 0, 3),
    /client 1: connection lost/,
  );
  assert.deepEqual(finished.sort(), [0, 2]);
});

test('records pool latencies and divide total operations by phase wall time', () => {
  // Client A: 1..4 ms, client B: 100..400 ms. The pooled median is 4 ms (rank 4 of 8); the mean of per-client medians would be 51 ms.
  const pooled = [1, 2, 3, 4, 100, 200, 300, 400];
  const record = toRecord({
    workload_id: 'archive_streaming', phase: 'steady', git_sha: 'd'.repeat(40), started_at: '2026-10-21T00:00:00Z', fixture_sha256: 'e'.repeat(64), concurrency: 2, errors: 1, checked: 8, dropped_samples: 0, parameters: {},
    sample: { latencies: pooled, wallMs: 2_000, cpuMs: 500, gcMs: 0, loopP99Ms: 0, peak: { rss: 1, heap: 1, external: 1 }, rssSeries: [] },
  });
  assert.equal(record.metrics['latency_p50'], 4);
  assert.equal(record.metrics['latency_p99'], 400);
  assert.equal(record.metrics['throughput'], 4);
  assert.equal(record.metrics['cpu'], 25);
  assert.equal(record.metrics['error_rate'], 1 / 8);
  assert.equal(record.offered_load.concurrency, 2);
});

const mysqlUrl = process.env['SANCTUM_TEST_MYSQL_URL'];

test('database job aggregates one and two disposable-database clients', { skip: mysqlUrl === undefined && 'SANCTUM_TEST_MYSQL_URL is not set' }, async () => {
  // Every run needs fresh databases: a second archive pass would collide with the first pass's chunk sequences.
  const databases = await Promise.all([1, 2, 3, 4, 5].map(() => createDatabase(mysqlUrl!)));
  const counts = { chunks: 2, chunk_seconds: 1, segments: 4, operations: 10 };
  const job = (clients: ReadonlyArray<{ url: string; ids: FixtureIds }>): Job => ({ git_sha: 'd'.repeat(40), started_at: '2026-10-21T00:00:00Z', workload: 'database', archive_seed: 0, ...counts, clients: clients.map(db => ({ database_url: db.url, ids: db.ids })) });
  try {
    const one = await runJob(job([databases[0]!]));
    const two = await runJob(job([databases[1]!, databases[2]!]));
    const names = ['archive_streaming', 'transcript_ingest', 'context_read_write'];
    assert.deepEqual(one.map(record => record.workload_id), names);
    assert.deepEqual(two.map(record => record.workload_id), names);
    const per = [counts.chunks, counts.segments, counts.operations];
    two.forEach((record, i) => {
      assert.equal(record.offered_load.concurrency, 2);
      assert.equal(record.repetitions, per[i]! * 2);
      assert.equal(record.correctness.errors, 0);
      assert.deepEqual(record.parameters['client_errors'], [0, 0]);
      assert.equal(record.fixture_sha256, one[i]!.fixture_sha256);
    });
    one.forEach((record, i) => {
      assert.equal(record.offered_load.concurrency, 1);
      assert.equal(record.repetitions, per[i]!);
      assert.equal(record.correctness.errors, 0);
    });
    // A client whose fixture rows are missing counts failed operations and then fails the whole job instead of producing a record.
    await assert.rejects(runJob(job([databases[3]!, { url: databases[4]!.url, ids: databases[3]!.ids }])), /needs transcript_ingest/);
  } finally {
    await Promise.all(databases.map(db => db.drop()));
  }
});
