import { SqlClient } from '@effect/sql';
import { expect, layer } from '@effect/vitest';
import { type AccessScope, type CaptureEpochId, type ListenerId, RecordingChunkId } from '@sanctum/contracts';
import { syntheticPcm } from '@sanctum/contracts/fixtures';
import { randomUUID } from 'node:crypto';
import { Effect, Layer } from 'effect';
import { ObjectStore } from '../src/providers/object-store.ts';
import { listCommittedChunks } from '../src/recordings.ts';
import { api, chunk, claimListener, fakeSpeech, MigratedDatabase, newEpochId, openSocket, seedDevice, uploadChunk, serveApi, startMessage } from './support/media.ts';
import { serverLayer } from '../src/main.ts';
import { memoryObjectStore } from './support/object-store.ts';

/** Memory R2 double that counts writes and can crash the process right after a write lands. */
function instrumentedStore() {
  const memory = memoryObjectStore();
  const stats = { puts: 0, crashAfterPut: false };
  const layer = Layer.effect(
    ObjectStore,
    Effect.map(ObjectStore, store =>
      ObjectStore.of({
        ...store,
        put: (key, body, meta) => {
          stats.puts++;
          return Effect.tap(store.put(key, body, meta), () => (stats.crashAfterPut ? Effect.die('process crashed after the R2 write') : Effect.void));
        },
      }),
    ),
  ).pipe(Layer.provide(memory.layer));
  return { memory, stats, layer };
}

const setup = Effect.gen(function* () {
  const tokens = new Map<string, AccessScope>();
  const store = instrumentedStore();
  const host = yield* serveApi(serverLayer, tokens, Layer.merge(store.layer, fakeSpeech().layer));
  const device = yield* seedDevice('Room A');
  tokens.set('device', device);
  const { listener_id, lease_generation } = yield* claimListener(host, 'device');
  const epoch_id = newEpochId();
  const socket = yield* openSocket(host, listener_id, 'device');
  socket.send(startMessage({ listener_id, epoch_id, lease_generation }));
  yield* socket.take('accepted');
  socket.close();
  return { tokens, store, host, device, listener_id, epoch_id };
});

const samples = (seed: number) => syntheticPcm({ sampleRate: 16_000, seconds: 1, toneHz: 220 + seed });

const upload = (listener_id: ListenerId, epoch_id: CaptureEpochId, sequence: number) =>
  chunk({ listener_id, epoch_id, sequence, sample_start: sequence * 16_000, samples: samples(sequence) });

const chunkState = (chunk_id: string) =>
  Effect.flatMap(SqlClient.SqlClient, sql => sql<{ upload_state: string }>`SELECT upload_state FROM recording_chunks WHERE id = ${chunk_id}`);

layer(MigratedDatabase, { timeout: 120_000 })('recording chunk uploads', it => {
  it.scoped('commits the R2 object and manifest before returning a receipt, then schedules reconciliation', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { host, store, device, listener_id, epoch_id } = yield* setup;
      const first = upload(listener_id, epoch_id, 0);
      const response = yield* uploadChunk(host, 'device', first);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ chunk_id: first.manifest.chunk_id, sha256: first.manifest.sha256, byte_length: first.body.byteLength });
      expect(store.memory.objects.get(response.body.object_key)).toMatchObject({ sha256: first.manifest.sha256, contentType: 'audio/wav' });
      expect((yield* chunkState(first.manifest.chunk_id))[0]!.upload_state).toBe('committed');

      const [job] = yield* sql<{ work_key: string; is_delayed: number }>`
        SELECT work_key, available_at > UTC_TIMESTAMP(6) + INTERVAL 50 SECOND AS is_delayed FROM jobs WHERE workspace_id = ${device.workspace_id} AND kind = 'transcript.reconcile'`;
      expect(job).toMatchObject({ work_key: `${epoch_id}:0:0` });
      expect(Number(job!.is_delayed)).toBe(1);

      const listed = yield* listCommittedChunks({ workspace_id: device.workspace_id, source: { epoch_id, track: 0, sample_start: 8_000, sample_end: 9_000 } });
      expect(listed).toEqual([{ ...first.manifest, object_key: response.body.object_key }]);
    }),
  );

  it.scoped('returns the original receipt for a repeated chunk and rejects conflicting content', () =>
    Effect.gen(function* () {
      const { host, store, listener_id, epoch_id } = yield* setup;
      const first = upload(listener_id, epoch_id, 0);
      const receipt = (yield* uploadChunk(host, 'device', first)).body;
      expect((yield* uploadChunk(host, 'device', first)).body).toEqual(receipt);
      expect(store.stats.puts).toBe(1);

      const sameId = chunk({ listener_id, epoch_id, sequence: 0, sample_start: 0, samples: samples(9) });
      const conflict = yield* uploadChunk(host, 'device', { body: sameId.body, manifest: { ...sameId.manifest, chunk_id: first.manifest.chunk_id } });
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({ code: 'hash_conflict', existing_sha256: first.manifest.sha256 });
      expect((yield* uploadChunk(host, 'device', upload(listener_id, epoch_id, 0))).status).toBe(409);
      const shifted = chunk({ listener_id, epoch_id, sequence: 7, sample_start: 8_000, samples: samples(7) });
      expect((yield* uploadChunk(host, 'device', shifted)).status).toBe(409);
    }),
  );

  it.scoped('reconciles an R2 write that landed when the manifest commit never happened', () =>
    Effect.gen(function* () {
      const { host, store, listener_id, epoch_id } = yield* setup;
      const first = upload(listener_id, epoch_id, 0);
      store.stats.crashAfterPut = true;
      expect((yield* uploadChunk(host, 'device', first)).status).toBe(500);
      expect([...store.memory.objects.values()].map(object => object.sha256)).toEqual([first.manifest.sha256]);
      expect((yield* chunkState(first.manifest.chunk_id))[0]!.upload_state).toBe('pending');

      store.stats.crashAfterPut = false;
      const retried = yield* uploadChunk(host, 'device', first);
      expect(retried.status).toBe(200);
      expect(store.stats.puts).toBe(1);
      expect((yield* chunkState(first.manifest.chunk_id))[0]!.upload_state).toBe('committed');
    }),
  );

  it.scoped('resolves an ambiguous R2 timeout with head and reports a failed write as retryable', () =>
    Effect.gen(function* () {
      const { host, store, listener_id, epoch_id } = yield* setup;
      store.memory.failNext('put', { ambiguous: true });
      expect((yield* uploadChunk(host, 'device', upload(listener_id, epoch_id, 0))).status).toBe(200);

      const second = upload(listener_id, epoch_id, 1);
      store.memory.failNext('put');
      const failed = yield* uploadChunk(host, 'device', second);
      expect(failed.status).toBe(503);
      expect(failed.body).toMatchObject({ code: 'unavailable', retryable: true });
      expect((yield* chunkState(second.manifest.chunk_id))[0]!.upload_state).toBe('pending');
      expect((yield* uploadChunk(host, 'device', second)).status).toBe(200);
    }),
  );

  it.scoped('accepts an offline backlog uploaded late and out of order', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { host, device, listener_id, epoch_id } = yield* setup;
      const backlog = [0, 1, 2, 3].map(sequence => upload(listener_id, epoch_id, sequence));
      for (const pending of [...backlog].reverse()) expect((yield* uploadChunk(host, 'device', pending)).status).toBe(200);
      const listed = yield* listCommittedChunks({ workspace_id: device.workspace_id, source: { epoch_id, track: 0, sample_start: 0, sample_end: 64_000 } });
      expect(listed.map(row => row.chunk_id)).toEqual(backlog.map(pending => pending.manifest.chunk_id));
      const jobs = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM jobs WHERE workspace_id = ${device.workspace_id} AND kind = 'transcript.reconcile'`;
      expect(Number(jobs[0]!.count)).toBe(4);
    }),
  );

  it.scoped('rejects chunks that do not match their manifest, epoch or owner', () =>
    Effect.gen(function* () {
      const { tokens, host, listener_id, epoch_id } = yield* setup;
      tokens.set('other', yield* seedDevice('Room B'));
      const valid = upload(listener_id, epoch_id, 0);
      const tampered = valid.body.slice();
      tampered[100] = tampered[100]! ^ 0xff;
      expect((yield* uploadChunk(host, 'device', { ...valid, body: tampered })).status).toBe(400);
      const wrongRate = chunk({ listener_id, epoch_id, sequence: 0, sample_start: 0, samples: samples(0), sample_rate: 48_000 });
      expect((yield* uploadChunk(host, 'device', wrongRate)).status).toBe(400);
      const pathMismatch = { ...valid, manifest: { ...valid.manifest, chunk_id: RecordingChunkId.make(randomUUID()) } };
      expect((yield* api(host, 'device', 'PUT', `/listeners/${listener_id}/chunks/${valid.manifest.chunk_id}`, valid.body, { 'content-type': 'audio/wav', 'x-sanctum-manifest': JSON.stringify(pathMismatch.manifest) })).status).toBe(400);
      expect((yield* uploadChunk(host, 'device', upload(listener_id, newEpochId(), 0))).status).toBe(404);
      expect((yield* uploadChunk(host, 'other', valid)).status).toBe(404);
      expect((yield* uploadChunk(host, 'device', valid)).status).toBe(200);
    }),
  );
});
