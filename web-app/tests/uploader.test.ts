import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ListenerId, RecordingChunkManifest, RecordingChunkReceipt } from '@sanctum/contracts';
import { syntheticPcm } from '@sanctum/contracts/fixtures';
import { Effect, Exit, Schedule } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeListenersClient } from '../src/lib/capture/client.ts';
import { sealChunk, type SealedChunk } from '../src/lib/capture/recorder.ts';
import { drainPending, type PendingStore, type UploaderOptions } from '../src/lib/capture/uploader.ts';

const LISTENER = '0b7a2c55-8a8e-4f35-9d5e-3c6b2f1d0a10' as ListenerId;
const EPOCH = '0b7a2c55-8a8e-4f35-9d5e-3c6b2f1d0a11';
const RATE = 16_000;

type Fault = 'db_fail' | 'hang' | 'unauthorized' | 'wrong_receipt';

/**
 * In-process stand-in for the media slice's `putChunk`: an object map plays R2, a receipt map
 * plays the MySQL manifest, and scripted faults fail individual requests.
 */
class FakeListenersServer {
  readonly objects = new Map<string, string>();
  readonly receipts = new Map<string, RecordingChunkReceipt>();
  readonly faults: Fault[] = [];
  readonly requests: Array<{ path: string; manifest: RecordingChunkManifest; sha256: string }> = [];
  objectWrites = 0;
  private readonly server: Server = createServer((req, res) => void this.handle(req, res));

  listen(port = 0): Promise<string> {
    return new Promise((resolve) => this.server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${(this.server.address() as AddressInfo).port}`)));
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = Buffer.concat(await req.toArray());
    const manifest = JSON.parse(String(req.headers['x-sanctum-manifest'])) as RecordingChunkManifest;
    const sha256 = createHash('sha256').update(body).digest('hex');
    this.requests.push({ path: `${req.method} ${req.url}`, manifest, sha256 });
    const fault = this.faults.shift();
    if (fault === 'hang') return;
    if (fault === 'unauthorized') return send(res, 401, { _tag: 'Unauthenticated', code: 'unauthenticated', retryable: false, message: 'sign in' });
    const [status, reply] = this.store(manifest.chunk_id, sha256, body.length, fault);
    send(res, status, reply);
  }

  /** R2 write, then manifest commit; the same chunk ID with other bytes conflicts. */
  private store(id: string, sha256: string, byteLength: number, fault: Fault | undefined): [number, unknown] {
    const committed = this.receipts.get(id);
    const stored = committed?.sha256 ?? this.objects.get(id);
    if (stored !== undefined && stored !== sha256) {
      return [409, { _tag: 'HashConflict', code: 'hash_conflict', retryable: false, message: 'chunk exists', existing_sha256: stored }];
    }
    if (committed !== undefined) return [200, committed];
    if (stored === undefined) this.objectWrites++;
    this.objects.set(id, sha256);
    if (fault === 'db_fail') return [503, { _tag: 'Unavailable', code: 'unavailable', retryable: true, message: 'manifest write failed' }];
    const receipt = { chunk_id: id, object_key: `audio/${id}.wav`, sha256, byte_length: byteLength, committed_at: '2026-09-29T09:00:00.000Z' } as RecordingChunkReceipt;
    this.receipts.set(id, receipt);
    return [200, fault === 'wrong_receipt' ? { ...receipt, sha256: '0'.repeat(64) } : receipt];
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** Test-side stand-in for the IndexedDB buffer, which the browser suite exercises for real. */
class MemoryPending implements PendingStore {
  readonly chunks = new Map<string, SealedChunk>();
  readonly journal: RecordingChunkReceipt[] = [];

  async nextPending(listenerId: string, skip: ReadonlySet<string>): Promise<SealedChunk | null> {
    return [...this.chunks.values()].find(({ manifest }) => manifest.listener_id === listenerId && !skip.has(manifest.chunk_id)) ?? null;
  }

  async acknowledge(manifest: RecordingChunkManifest, receipt: RecordingChunkReceipt): Promise<void> {
    this.journal.push(receipt);
    this.chunks.delete(manifest.chunk_id);
  }
}

async function chunk(sequence: number, toneHz = 440): Promise<SealedChunk> {
  const samples = syntheticPcm({ sampleRate: RATE, seconds: 0.5, toneHz });
  const header = {
    chunk_id: crypto.randomUUID(),
    listener_id: LISTENER,
    epoch_id: EPOCH,
    sequence,
    sample_rate: RATE,
    chunk_start: sequence * samples.length,
    captured_at: new Date(Date.UTC(2026, 8, 29, 9) + sequence * 500).toISOString(),
  };
  return sealChunk(header, samples);
}

async function pendingWith(count: number): Promise<MemoryPending> {
  const store = new MemoryPending();
  for (let i = 0; i < count; i++) {
    const sealed = await chunk(i);
    store.chunks.set(sealed.manifest.chunk_id, sealed);
  }
  return store;
}

const servers: FakeListenersServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function start(): Promise<{ server: FakeListenersServer; baseUrl: string }> {
  const server = new FakeListenersServer();
  servers.push(server);
  return { server, baseUrl: await server.listen() };
}

const fast: UploaderOptions = { timeout: '2 seconds', retry: Schedule.spaced('10 millis') };

function drain(store: PendingStore, baseUrl: string, options: UploaderOptions = fast) {
  const events: string[] = [];
  const effect = drainPending(
    store,
    makeListenersClient(baseUrl),
    LISTENER,
    {
      onUploading: (manifest) => events.push(`uploading ${manifest.sequence}`),
      onSaved: (manifest) => events.push(`saved ${manifest.sequence}`),
      onConflict: (manifest) => events.push(`conflict ${manifest.sequence}`),
    },
    options,
  );
  return { events, run: () => Effect.runPromiseExit(effect) };
}

describe('chunk uploader', () => {
  it('uploads the backlog oldest first and deletes local audio only with a matching receipt', async () => {
    const { server, baseUrl } = await start();
    const store = await pendingWith(3);
    const manifests = [...store.chunks.values()].map((sealed) => sealed.manifest);
    const { events, run } = drain(store, baseUrl);

    expect(Exit.isSuccess(await run())).toBe(true);
    expect(events).toEqual(['uploading 0', 'saved 0', 'uploading 1', 'saved 1', 'uploading 2', 'saved 2']);
    expect(server.requests.map((request) => request.path)).toEqual(manifests.map((manifest) => `PUT /api/v1/listeners/${LISTENER}/chunks/${manifest.chunk_id}`));
    expect(server.requests.map((request) => request.manifest)).toEqual(manifests);
    expect(server.requests.map((request) => request.sha256)).toEqual(manifests.map((manifest) => manifest.sha256));
    expect(store.chunks.size).toBe(0);
    expect(store.journal.map((receipt) => receipt.chunk_id)).toEqual(manifests.map((manifest) => manifest.chunk_id));
  });

  it('keeps the chunk after R2 succeeded but the manifest failed, then completes it on retry', async () => {
    const { server, baseUrl } = await start();
    const store = await pendingWith(1);
    const [id] = store.chunks.keys();
    server.faults.push('db_fail');
    const { run } = drain(store, baseUrl, { retry: Schedule.recurs(0) });

    expect(await run()).toEqual(Exit.fail('unavailable'));
    expect(server.objects.has(id!)).toBe(true);
    expect(store.chunks.has(id!)).toBe(true);

    expect(Exit.isSuccess(await drain(store, baseUrl).run())).toBe(true);
    expect(store.chunks.size).toBe(0);
    expect(server.objectWrites).toBe(1);
    expect(store.journal[0]).toEqual(server.receipts.get(id!));
  });

  it('accepts the original receipt for a repeated identical chunk', async () => {
    const { server, baseUrl } = await start();
    const store = await pendingWith(1);
    const [sealed] = store.chunks.values();
    expect(Exit.isSuccess(await drain(store, baseUrl).run())).toBe(true);
    store.chunks.set(sealed!.manifest.chunk_id, sealed!);

    expect(Exit.isSuccess(await drain(store, baseUrl).run())).toBe(true);
    expect(store.journal).toHaveLength(2);
    expect(store.journal[1]).toEqual(store.journal[0]);
    expect(server.objectWrites).toBe(1);
  });

  it('keeps a chunk whose ID already holds different bytes and continues with the rest', async () => {
    const { server, baseUrl } = await start();
    const store = await pendingWith(2);
    const [first] = store.chunks.values();
    server.receipts.set(first!.manifest.chunk_id, { ...first!.manifest, object_key: 'audio/other.wav', sha256: 'f'.repeat(64), committed_at: '2026-09-29T08:00:00.000Z' } as unknown as RecordingChunkReceipt);
    const { events, run } = drain(store, baseUrl);

    expect(Exit.isSuccess(await run())).toBe(true);
    expect(events).toEqual(['uploading 0', 'conflict 0', 'uploading 1', 'saved 1']);
    expect([...store.chunks.keys()]).toEqual([first!.manifest.chunk_id]);
  });

  it('never deletes local audio for a receipt that does not match the manifest', async () => {
    const { server, baseUrl } = await start();
    const store = await pendingWith(1);
    server.faults.push('wrong_receipt');
    const { run } = drain(store, baseUrl);

    expect(Exit.isSuccess(await run())).toBe(true);
    expect(server.requests).toHaveLength(2);
    expect(store.journal.map((receipt) => receipt.sha256)).toEqual([server.requests[0]!.sha256]);
  });

  it('abandons a request that exceeds the timeout and retries the same chunk', async () => {
    const { server, baseUrl } = await start();
    const store = await pendingWith(1);
    server.faults.push('hang');
    // The server really holds the socket open, so the real Effect clock must fire the timeout.
    const { run } = drain(store, baseUrl, { timeout: '150 millis', retry: Schedule.spaced('10 millis') });

    expect(Exit.isSuccess(await run())).toBe(true);
    expect(server.requests.map((request) => request.manifest.chunk_id)).toEqual([...store.journal, ...store.journal].map((receipt) => receipt.chunk_id));
    expect(store.chunks.size).toBe(0);
  });

  it('holds an offline backlog and uploads it once the server is reachable', async () => {
    const probe = new FakeListenersServer();
    const baseUrl = await probe.listen();
    await probe.close();
    const store = await pendingWith(3);
    let failures = 0;
    const retry = Schedule.spaced('10 millis').pipe(Schedule.tapInput(() => Effect.sync(() => failures++)));
    const { run } = drain(store, baseUrl, { timeout: '2 seconds', retry });
    const done = run();

    await vi.waitFor(() => expect(failures).toBeGreaterThan(2));
    expect(store.chunks.size).toBe(3);
    const server = new FakeListenersServer();
    servers.push(server);
    await server.listen(Number(new URL(baseUrl).port));

    expect(Exit.isSuccess(await done)).toBe(true);
    expect(store.chunks.size).toBe(0);
    expect(server.receipts.size).toBe(3);
  });

  it('stops without deleting anything when the session is not authorized', async () => {
    const { server, baseUrl } = await start();
    const store = await pendingWith(2);
    server.faults.push('unauthorized');

    expect(await drain(store, baseUrl).run()).toEqual(Exit.fail('unauthorized'));
    expect(store.chunks.size).toBe(2);
    expect(server.requests).toHaveLength(1);
  });
});
