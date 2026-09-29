import { NotFound, Unavailable, type RecordingChunkManifest, type RecordingChunkReceipt, type StartMessage } from '@sanctum/contracts';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpochEnd } from '../src/lib/capture/buffer.ts';
import type { ListenersClient } from '../src/lib/capture/client.ts';
import { createCaptureController, type CaptureBuffer, type CaptureDeps } from '../src/lib/capture/controller.ts';
import type { LiveOptions, LiveStream, StopReason } from '../src/lib/capture/live.ts';
import { sealChunk, StorageError, type PartRecord, type SealedChunk } from '../src/lib/capture/recorder.ts';

const LISTENER_ID = '5f0d6f0e-8c1b-4b8e-a4f3-2d9c7a1e4b01';
/** Registered after the server forgot LISTENER_ID. */
const NEXT_LISTENER_ID = '9a4e2b1c-3d5f-4e6a-8b7c-0d1e2f3a4b5c';
const RATE = 48_000;
const BLOCK = 2_400;

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = 'live';
  stop(): void {
    this.readyState = 'ended';
  }
  unplug(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeStatus extends EventTarget {
  state: PermissionState = 'prompt';
  set(state: PermissionState): void {
    this.state = state;
    this.dispatchEvent(new Event('change'));
  }
}

class FakeSentinel extends EventTarget {
  released = false;
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }
}

/** Test-side stand-in for the IndexedDB buffer; the browser suite covers the real one. */
class MemoryBuffer implements CaptureBuffer {
  readonly parts: PartRecord[] = [];
  readonly chunks = new Map<string, SealedChunk>();
  orphans = 0;
  /** Chunks a crashed tab left as committed parts; recovery seals them. */
  readonly orphaned: SealedChunk[] = [];
  freeBytes = 1e9;
  onLost = () => { };
  async appendPart(part: PartRecord) {
    this.parts.push(part);
  }
  async sealChunk(chunk: SealedChunk) {
    this.chunks.set(chunk.manifest.chunk_id, chunk);
  }
  readonly starts = new Map<string, typeof StartMessage.Type>();
  async saveEpoch(start: typeof StartMessage.Type) {
    this.starts.set(start.epoch_id, start);
  }
  async endEpoch(epochId: string, reason: EpochEnd) {
    const start = this.starts.get(epochId);
    if (start) this.starts.set(epochId, { ...start, end_reason: reason });
  }
  async epochStart(epochId: string) {
    return this.starts.get(epochId) ?? null;
  }
  readonly refused = new Set<string>();
  async epochSampleEnd(listenerId: string, epochId: string) {
    const ends = [...this.chunks.values()].filter(({ manifest }) => manifest.listener_id === listenerId && manifest.epoch_id === epochId).map(({ manifest }) => manifest.sample_start + manifest.sample_count);
    return ends.length === 0 ? null : Math.max(...ends);
  }
  async nextPending(listenerId: string) {
    return [...this.chunks.values()].find((chunk) => chunk.manifest.listener_id === listenerId && !this.refused.has(chunk.manifest.chunk_id)) ?? null;
  }
  async markRefused(chunkId: string) {
    this.refused.add(chunkId);
  }
  async acknowledge(manifest: RecordingChunkManifest) {
    this.chunks.delete(manifest.chunk_id);
    this.starts.delete(manifest.epoch_id);
  }
  async countChunks(listenerId: string | null) {
    const pending = [...this.chunks.values()].filter((chunk) => chunk.manifest.listener_id === listenerId && !this.refused.has(chunk.manifest.chunk_id)).length;
    return { pending, stranded: this.chunks.size - pending };
  }
  async orphanedRecordings() {
    return [];
  }
  async recordingChunks() {
    return [];
  }
  async discardRecording(listenerId: string, epochId: string, owned: readonly string[]) {
    if (owned.includes(listenerId)) return;
    for (const [id, { manifest }] of this.chunks) if (manifest.listener_id === listenerId && manifest.epoch_id === epochId) this.chunks.delete(id);
  }
  async savedThroughMs() {
    return null;
  }
  async recoverOrphans() {
    const recovered = this.orphaned.splice(0);
    recovered.forEach((chunk) => this.chunks.set(chunk.manifest.chunk_id, chunk));
    return this.orphans + recovered.length;
  }
  async persist() {
    return true;
  }
  close() { }
}

class FakeLocks {
  private held = false;
  request(_name: string, _options: LockOptions, callback: (lock: Lock | null) => Promise<void> | undefined) {
    if (this.held) return Promise.resolve(callback(null));
    this.held = true;
    return Promise.resolve(callback({ name: 'sanctum-capture', mode: 'exclusive' })).finally(() => (this.held = false));
  }
}

/** `stopped` is `undefined` until the stream stops. */
type FakeLive = { options: LiveOptions; sent: number[]; stopped?: StopReason };

const receipt = (manifest: RecordingChunkManifest) =>
  ({ chunk_id: manifest.chunk_id, object_key: 'k', sha256: manifest.sha256, byte_length: manifest.byte_length, committed_at: '2026-09-29T09:00:00Z' }) as RecordingChunkReceipt;

/** The listener API as the real server behaves: identity is the lease generation alone. */
class FakeListenerServer {
  readonly lives: FakeLive[] = [];
  readonly calls = { register: 0, heartbeat: [] as unknown[], put: [] as RecordingChunkManifest[] };
  /** The server's lease: `active` while its holder keeps renewing. */
  private generation: number;
  private active: boolean;
  /** When each generation was claimed. */
  private readonly claims: Array<{ generation: number; at: number }>;
  /** The server forgot LISTENER_ID: its heartbeat and uploads fail NotFound, and registration issues a new id. */
  private forgotten = false;
  /** Registered epochs and their generation; chunks of any other epoch, or ending after a later claim, are NotFound. */
  private readonly epochs: Map<string, number>;
  /** Heartbeats and archive registrations cannot reach the server. */
  private offline = false;
  /** Another capture-group member holds live writes: heartbeats still renew this listener but report `owner: false`. */
  private groupHeld = false;
  private readonly lease = { lease_expires_at: '2026-09-29T09:00:45Z' };

  private readonly options: { unclaimed?: boolean; epochs?: string[] };

  constructor(options: { unclaimed?: boolean; epochs?: string[] }) {
    this.options = options;
    this.generation = options.unclaimed ? 0 : 1;
    this.active = !options.unclaimed;
    this.claims = options.unclaimed ? [] : [{ generation: 1, at: 0 }];
    this.epochs = new Map((options.epochs ?? []).map((id) => [id, 1]));
  }

  readonly client = {
    registerListener: () => {
      this.calls.register++;
      return Effect.succeed({ id: this.forgotten ? NEXT_LISTENER_ID : LISTENER_ID, lease_generation: this.options.unclaimed ? 0 : 1 });
    },
    heartbeat: (request: { path: { listener_id: string }; payload: { lease_generation: number } }) => this.heartbeat(request),
    putChunk: (request: { headers: { 'x-sanctum-manifest': RecordingChunkManifest } }) => this.putChunk(request.headers['x-sanctum-manifest']),
  } as unknown as ListenersClient;

  private claimedAfter(held: number, atMs: number): boolean {
    return this.claims.some((claim) => claim.generation > held && claim.at < atMs);
  }

  private heartbeat(request: { path: { listener_id: string }; payload: { lease_generation: number } }) {
    this.calls.heartbeat.push(request.payload);
    if (this.offline) return Effect.fail(new Unavailable({ message: 'offline', retryable: true }));
    if (this.forgotten && request.path.listener_id === LISTENER_ID) return Effect.fail(new NotFound({ message: 'listener not found' }));
    const held = request.payload.lease_generation;
    if (this.active && held !== this.generation) return Effect.succeed({ ...this.lease, lease_generation: held, owner: false });
    if (held !== this.generation || this.generation === 0) this.claims.push({ generation: ++this.generation, at: Date.now() }); // takeover of an expired (or never claimed) lease
    this.active = true;
    return Effect.succeed({ ...this.lease, lease_generation: this.generation, owner: !this.groupHeld });
  }

  private putChunk(manifest: RecordingChunkManifest) {
    if (this.forgotten && manifest.listener_id === LISTENER_ID) return Effect.fail(new NotFound({ message: 'listener not found' }));
    const held = this.epochs.get(manifest.epoch_id);
    const end = Date.parse(manifest.captured_at) + (manifest.sample_count / manifest.sample_rate) * 1000;
    if (held === undefined || this.claimedAfter(held, end)) return Effect.fail(new NotFound({ message: 'Capture epoch not found for this listener' }));
    this.calls.put.push(manifest);
    return Effect.succeed(receipt(manifest));
  }

  private registerArchive(liveOptions: LiveOptions): void {
    const { start } = liveOptions;
    if (this.offline) return liveOptions.onStatus('reconnecting');
    if (start.lease_generation > this.generation || this.claimedAfter(start.lease_generation, Date.parse(start.clock.captured_at))) return liveOptions.onStatus('rejected', 'stale_generation');
    this.epochs.set(start.epoch_id, start.lease_generation);
    liveOptions.onStatus('live');
  }

  private startLive(liveOptions: LiveOptions): void {
    const { start } = liveOptions;
    if (this.offline) queueMicrotask(() => liveOptions.onStatus('reconnecting'));
    else if (this.active && !this.groupHeld && start.lease_generation === this.generation) this.epochs.set(start.epoch_id, start.lease_generation);
    else queueMicrotask(() => liveOptions.onStatus('rejected', 'stale_generation'));
  }

  readonly openLive = (liveOptions: LiveOptions): LiveStream => {
    const live: FakeLive = { options: liveOptions, sent: [] };
    this.lives.push(live);
    if (liveOptions.start.archive_only) queueMicrotask(() => this.registerArchive(liveOptions));
    else this.startLive(liveOptions);
    liveOptions.onStatus('connecting');
    return { send: (start) => void live.sent.push(start), stop: (reason) => void (live.stopped = reason) };
  };

  /** `false`: another device claims the lease; `true`: the winner's lease expires, so the next heartbeat takes it over. */
  readonly setOwner = (value: boolean) => {
    if (value) this.active = false;
    else this.claims.push({ generation: ++this.generation, at: Date.now() });
  };

  readonly setOffline = (value: boolean) => {
    this.offline = value;
  };

  readonly setGroupHeld = (value: boolean) => {
    this.groupHeld = value;
  };

  readonly forget = () => {
    this.forgotten = true;
  };
}

function harness(options: { secure?: boolean; getUserMedia?: () => Promise<MediaStream>; buffer?: MemoryBuffer; locks?: FakeLocks; stored?: boolean; unclaimed?: boolean; epochs?: string[] } = {}) {
  const win = Object.assign(new EventTarget(), { isSecureContext: options.secure ?? true });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const tracks: FakeTrack[] = [];
  const microphone = async () => {
    const track = tracks[tracks.push(new FakeTrack()) - 1];
    return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  };
  const status = new FakeStatus();
  const sentinels: FakeSentinel[] = [];
  const buffer = options.buffer ?? new MemoryBuffer();
  const storage = new Map<string, string>(options.stored ? [['sanctum.listener', JSON.stringify({ id: LISTENER_ID, lease_generation: 1 })]] : []);
  const server = new FakeListenerServer(options);
  let onBlock: ((start: number, samples: Int16Array) => void) | null = null;
  const { lives, calls, client } = server;
  const deps: CaptureDeps = {
    window: win as unknown as NonNullable<CaptureDeps['window']>,
    document: doc as unknown as NonNullable<CaptureDeps['document']>,
    navigator: {
      mediaDevices: { getUserMedia: options.getUserMedia ?? microphone } as unknown as MediaDevices,
      permissions: { query: async () => status } as unknown as Permissions,
      wakeLock: { request: async () => sentinels[sentinels.push(new FakeSentinel()) - 1] } as unknown as WakeLock,
      locks: options.locks as unknown as LockManager,
    },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => void storage.set(key, value), removeItem: (key) => void storage.delete(key) },
    openBuffer: async () => buffer,
    startRecorder: async (_stream, callback) => {
      onBlock = callback;
      return { sampleRate: RATE, levels: { bandCount: 33, read: (bands) => (bands.fill(0.5), 0.5) }, flush: async () => { }, close: async () => { } };
    },
    client,
    openLive: server.openLive,
    streamUrl: (id) => `ws://test/api/v1/listeners/${id}/stream`,
    timing: { chunkSeconds: 1, commitSeconds: 0.5, heartbeatMs: 15_000, gapMs: 3_000 },
  };
  const engine = createCaptureController(deps);
  let next = 0;
  const feed = (seconds: number) => {
    for (let i = 0; i < (seconds * RATE) / BLOCK; i++, next += BLOCK) onBlock!(next, new Int16Array(BLOCK).fill(100));
  };
  const accept = () => lives.at(-1)!.options.onStatus('live');
  const reject = () => lives.at(-1)!.options.onStatus('rejected', 'stale_generation');
  const snapshot = () => engine.getSnapshot();
  return {
    get track() {
      return tracks.at(-1)!;
    },
    engine,
    win,
    doc,
    status,
    sentinels,
    buffer,
    storage,
    lives,
    calls,
    feed,
    accept,
    reject,
    snapshot,
    /** `false`: another device claims the lease; `true`: the winner's lease expires, so the next heartbeat takes it over. */
    setOwner: server.setOwner,
    setOffline: server.setOffline,
    setGroupHeld: server.setGroupHeld,
    forget: server.forget,
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 8, 29, 9), toFake: ['Date', 'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('capture lifecycle', () => {
  it('grants the microphone, registers once and reports listening only after live acceptance', async () => {
    const h = harness();
    await settle();
    expect(h.snapshot()).toMatchObject({ listener: 'stopped', permission: 'prompt', archive: null });

    await h.engine.start();
    expect(h.snapshot()).toMatchObject({ listener: 'starting', permission: 'granted', archive: 'capturing', issue: null, wakeLock: 'held' });
    expect(h.calls.register).toBe(1);
    expect(JSON.parse(h.storage.get('sanctum.listener')!)).toEqual({ id: LISTENER_ID, lease_generation: 1 });

    h.feed(0.1);
    h.accept();
    await settle();
    const { options } = h.lives[0]!;
    expect(h.snapshot()).toMatchObject({ listener: 'listening', epochId: options.start.epoch_id });
    expect(options.start).toMatchObject({ listener_id: LISTENER_ID, track: 0, lease_generation: 1, clock: { sample_rate: RATE, sample_start: 0, channels: 1 } });
    expect(h.lives[0]!.sent).toEqual([0, BLOCK]);

    const bands = new Float32Array(33);
    expect(h.engine.levels.read(bands)).toBe(0.5);
  });

  it('reports denial, missing input and hardware failures distinctly and can retry', async () => {
    for (const [name, permission, issue] of [
      ['NotAllowedError', 'denied', 'permission_denied'],
      ['NotFoundError', 'prompt', 'no_input'],
      ['NotReadableError', 'prompt', 'hardware_error'],
      ['OverconstrainedError', 'prompt', 'unsupported_constraints'],
    ] as const) {
      const locks = new FakeLocks();
      const h = harness({ locks, getUserMedia: () => Promise.reject(new DOMException('no', name)) });
      await h.engine.start();
      expect(h.snapshot()).toMatchObject({ listener: 'stopped', permission, issue, archive: null });
      await h.engine.start();
      expect(h.snapshot().issue).toBe(issue); // the capture lock was released, so the retry reached the device again
    }
  });

  it('refuses insecure contexts before prompting', async () => {
    const getUserMedia = vi.fn();
    const h = harness({ secure: false, getUserMedia });
    await h.engine.start();
    expect(h.snapshot()).toMatchObject({ listener: 'stopped', permission: 'unsupported', issue: 'insecure_context' });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('stops and shows an interruption when permission is revoked', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.6);
    h.status.set('denied');
    await vi.waitFor(() =>
      expect(h.snapshot()).toMatchObject({ listener: 'paused', permission: 'denied', issue: 'permission_denied', archive: 'interrupted', epochId: null }),
    );
    expect(h.track.readyState).toBe('ended');
    await vi.waitFor(() => expect(h.calls.put.map((manifest) => manifest.sample_count)).toEqual([RATE * 0.6]));
  });

  it('degrades on a muted input and interrupts when the device is unplugged', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.accept();
    h.track.dispatchEvent(new Event('mute'));
    expect(h.snapshot()).toMatchObject({ listener: 'degraded', issue: 'input_lost' });
    h.track.dispatchEvent(new Event('unmute'));
    expect(h.snapshot()).toMatchObject({ listener: 'listening', issue: null });

    h.track.unplug();
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ listener: 'paused', issue: 'input_lost', archive: 'interrupted' }));
    expect(h.lives[0]!.stopped).toBe('interrupted');
  });

  it('keeps capturing while overlays subscribe and unsubscribe', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.accept();
    const overlay = h.engine.subscribe(() => { });
    overlay();
    h.feed(0.6);
    await settle();
    expect(h.snapshot().listener).toBe('listening');
    expect(h.track.readyState).toBe('live');
    expect(h.buffer.parts.length).toBeGreaterThan(0);
  });

  it('pauses after checkpointing and resumes in a fresh epoch', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.3);
    const first = h.lives[0]!.options.start.epoch_id;
    await h.engine.pause();
    expect(h.snapshot()).toMatchObject({ listener: 'paused', epochId: null, issue: null, wakeLock: 'released' });
    expect(h.lives[0]!.stopped).toBe('pause');
    await vi.waitFor(() => expect(h.calls.put.map((manifest) => [manifest.epoch_id, manifest.sample_count])).toEqual([[first, BLOCK * 6]]));

    await h.engine.resume();
    h.feed(0.1);
    await settle();
    expect(h.snapshot().epochId).not.toBe(first);
    expect(h.lives[1]!.options.start.epoch_id).not.toBe(first);
  });

  it('ends capture on tab close and reports the committed parts as interrupted on the next load', async () => {
    const closed = harness();
    await closed.engine.start();
    closed.feed(0.6);
    closed.win.dispatchEvent(new Event('pagehide'));
    expect(closed.track.readyState).toBe('ended');
    expect(closed.lives[0]!.stopped).toBe('interrupted');

    const buffer = new MemoryBuffer();
    buffer.orphans = 1;
    const recovered = await sealChunk(
      { chunk_id: crypto.randomUUID(), listener_id: LISTENER_ID, epoch_id: crypto.randomUUID(), sequence: 0, sample_rate: RATE, chunk_start: 0, captured_at: '2026-09-29T08:59:00.000Z' },
      new Int16Array(RATE),
    );
    await buffer.sealChunk(recovered);
    const reloaded = harness({ buffer, stored: true, epochs: [recovered.manifest.epoch_id] });
    await vi.waitFor(() => expect(reloaded.calls.put).toEqual([recovered.manifest]));
    await vi.waitFor(() => expect(reloaded.snapshot()).toMatchObject({ listener: 'stopped', archive: 'interrupted', bufferedChunks: 0 }));
  });

  it('seals parts a crashed tab left behind when this tab starts capture later', async () => {
    const locks = new FakeLocks();
    let crash!: () => void;
    void locks.request('sanctum-capture', { ifAvailable: true }, () => new Promise<void>((resolve) => (crash = resolve)));
    const orphan = await sealChunk(
      { chunk_id: crypto.randomUUID(), listener_id: LISTENER_ID, epoch_id: crypto.randomUUID(), sequence: 0, sample_rate: RATE, chunk_start: 0, captured_at: '2026-09-29T08:59:00.000Z' },
      new Int16Array(RATE),
    );
    const buffer = new MemoryBuffer();
    const h = harness({ buffer, locks, stored: true, epochs: [orphan.manifest.epoch_id] });
    await settle();
    buffer.orphaned.push(orphan);
    crash();
    await settle();
    await h.engine.start();
    await vi.waitFor(() => expect(h.calls.put).toEqual([orphan.manifest]));
  });

  it('keeps chunks of a forgotten listener as stranded local audio, not pending uploads', async () => {
    const buffer = new MemoryBuffer();
    const old = await sealChunk(
      { chunk_id: crypto.randomUUID(), listener_id: LISTENER_ID, epoch_id: crypto.randomUUID(), sequence: 0, sample_rate: RATE, chunk_start: 0, captured_at: '2026-09-29T08:59:00.000Z' },
      new Int16Array(RATE),
    );
    await buffer.sealChunk(old);
    const h = harness({ buffer, stored: true });
    h.forget();
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ archive: null, bufferedChunks: 0, strandedChunks: 1 })); // the upload was refused

    await vi.advanceTimersByTimeAsync(15_000); // the heartbeat learns the server no longer knows the listener
    expect(h.storage.has('sanctum.listener')).toBe(false);
    expect(h.snapshot()).toMatchObject({ archive: null, bufferedChunks: 0, strandedChunks: 1 });

    await h.engine.start();
    h.feed(1.2);
    await vi.waitFor(() => expect(h.calls.put.map((manifest) => manifest.listener_id)).toEqual([NEXT_LISTENER_ID]));
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ bufferedChunks: 0, strandedChunks: 1 }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.calls.heartbeat.at(-1)).toMatchObject({ buffered_chunks: 0 });
    expect(h.buffer.chunks.get(old.manifest.chunk_id)).toBe(old); // never deleted
  });

  it('reports chunks left by an earlier listener on load without claiming them as pending', async () => {
    const buffer = new MemoryBuffer();
    const old = await sealChunk(
      { chunk_id: crypto.randomUUID(), listener_id: LISTENER_ID, epoch_id: crypto.randomUUID(), sequence: 0, sample_rate: RATE, chunk_start: 0, captured_at: '2026-09-29T08:59:00.000Z' },
      new Int16Array(RATE),
    );
    await buffer.sealChunk(old);
    const h = harness({ buffer });
    await settle();
    expect(h.snapshot()).toMatchObject({ listener: 'stopped', archive: null, bufferedChunks: 0, strandedChunks: 1 });
    expect(h.calls.put).toEqual([]);
    expect(buffer.chunks.has(old.manifest.chunk_id)).toBe(true);
  });

  it('never discards pending audio of the listener another tab registered after this one loaded', async () => {
    const buffer = new MemoryBuffer();
    const seal = (listener_id: string) =>
      sealChunk({ chunk_id: crypto.randomUUID(), listener_id, epoch_id: crypto.randomUUID(), sequence: 0, sample_rate: RATE, chunk_start: 0, captured_at: '2026-09-29T08:59:00.000Z' }, new Int16Array(RATE));
    const [removed, pending] = await Promise.all([seal(LISTENER_ID), seal(NEXT_LISTENER_ID)]);
    await Promise.all([buffer.sealChunk(removed), buffer.sealChunk(pending)]);
    const h = harness({ buffer });
    await settle();
    h.storage.set('sanctum.listener', JSON.stringify({ id: NEXT_LISTENER_ID, lease_generation: 1 })); // another tab registered and records

    const recording = (chunk: SealedChunk) => ({ listenerId: chunk.manifest.listener_id, epochId: chunk.manifest.epoch_id, sampleRate: RATE, startedAt: chunk.manifest.captured_at, sampleCount: RATE, chunkCount: 1, gaps: [] });
    await h.engine.discardRecording(recording(pending));
    await h.engine.discardRecording(recording(removed));
    expect([...buffer.chunks.keys()]).toEqual([pending.manifest.chunk_id]);
  });

  it('starts a new epoch after a sleep gap instead of stretching the sample clock', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.2);
    const before = h.snapshot().epochId;
    vi.setSystemTime(Date.now() + 10 * 60_000);
    h.feed(0.1);
    await settle();
    expect(h.snapshot().epochId).not.toBe(before);
    expect(h.lives[0]!.stopped).toBe('close');
    expect(Date.parse(h.lives[1]!.options.start.clock.captured_at)).toBeGreaterThan(Date.now() - 1_000);
    expect(h.snapshot().listener).not.toBe('paused');
  });

  it('treats a frozen or discarded page as interrupted and checks the track when visible again', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.doc.dispatchEvent(new Event('freeze'));
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ listener: 'paused', archive: 'interrupted' }));

    const other = harness();
    await other.engine.start();
    other.track.readyState = 'ended';
    other.doc.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(other.snapshot()).toMatchObject({ listener: 'paused', issue: 'input_lost' }));
  });

  it('re-requests the wake lock when the page is visible again', async () => {
    const h = harness();
    await h.engine.start();
    await h.sentinels[0]!.release();
    expect(h.snapshot().wakeLock).toBe('released');
    h.doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(h.snapshot().wakeLock).toBe('held');
    expect(h.sentinels).toHaveLength(2);
  });

  it('stops live writes when the heartbeat reports another owner', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.accept();
    h.setOwner(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.snapshot()).toMatchObject({ listener: 'degraded', issue: 'lease_lost', epochId: null });
    expect(h.lives[0]!.stopped).toBe('close');
    expect(h.calls.heartbeat.at(-1)).toMatchObject({ lease_generation: 1, state: 'listening', buffered_chunks: 0 });
  });

  it('keeps its own generation after losing the lease and cannot restart live capture while the winner holds it', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.accept();
    h.setOwner(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(JSON.parse(h.storage.get('sanctum.listener')!)).toEqual({ id: LISTENER_ID, lease_generation: 1 });
    expect(h.calls.heartbeat.slice(-2)).toMatchObject([{ lease_generation: 1 }, { lease_generation: 1 }]);

    await h.engine.pause();
    await h.engine.resume();
    h.feed(0.1);
    await settle();
    expect(h.lives.filter((live) => !live.options.start.archive_only)).toHaveLength(1); // no live start after the loss
    expect(h.snapshot().listener).toBe('degraded');
    expect(h.buffer.starts.get(h.snapshot().epochId!)).toMatchObject({ lease_generation: 1 });
  });

  it('keeps the listener generation a heartbeat hands it while another group member holds live writes', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.accept();
    h.setGroupHeld(true);
    h.setOwner(false);
    h.setOwner(true); // the listener lease lapsed too: the next heartbeat takes it over at generation 3
    await vi.advanceTimersByTimeAsync(15_000);
    expect(JSON.parse(h.storage.get('sanctum.listener')!)).toEqual({ id: LISTENER_ID, lease_generation: 3 });
    expect(h.snapshot()).toMatchObject({ issue: 'lease_lost', epochId: null });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.calls.heartbeat.at(-1)).toMatchObject({ lease_generation: 3 });

    h.setGroupHeld(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.snapshot().issue).toBeNull();
    h.feed(0.1);
    expect(h.lives.at(-1)!.options.start).toMatchObject({ lease_generation: 3 });
    expect(JSON.parse(h.storage.get('sanctum.listener')!)).toEqual({ id: LISTENER_ID, lease_generation: 3 });
  });

  it('opens a fresh epoch under the new generation when the lease comes back', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.accept();
    const first = h.lives[0]!.options.start.epoch_id;
    h.setOwner(false);
    await vi.advanceTimersByTimeAsync(15_000);
    h.feed(0.1);
    await settle();
    const lost = h.snapshot().epochId;
    expect(lost).not.toBe(first);
    h.setOwner(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(JSON.parse(h.storage.get('sanctum.listener')!)).toMatchObject({ lease_generation: 3 });
    expect(h.snapshot()).toMatchObject({ listener: 'starting', issue: null, epochId: null }); // the old generation's epoch ended here
    expect(h.buffer.starts.get(lost!)).toMatchObject({ lease_generation: 1, end_reason: 'lease_lost' });
    h.feed(0.1);
    const [, next] = h.lives.filter((live) => !live.options.start.archive_only);
    expect(next!.options.start).toMatchObject({ lease_generation: 3 });
    next!.options.onStatus('live');
    await settle();
    expect(h.snapshot()).toMatchObject({ listener: 'listening', epochId: next!.options.start.epoch_id });
  });

  it('uploads an epoch whose start was refused for a lapsed lease once the heartbeat regains it', async () => {
    const h = harness({ stored: true });
    h.setOffline(true);
    await h.engine.start();
    h.feed(1.2);
    const offline = h.lives[0]!.options.start.epoch_id;
    await settle();
    expect(h.calls.put).toEqual([]);

    h.setOffline(false);
    h.reject(); // the reconnected socket replays a start the lapsed lease no longer covers
    await settle();
    expect(h.lives[1]!.options.start).toMatchObject({ epoch_id: offline, lease_generation: 1 });
    expect(h.snapshot()).toMatchObject({ issue: null, epochId: offline });
    h.feed(1.2);
    await vi.waitFor(() => expect(h.calls.put.map((manifest) => manifest.epoch_id)).toEqual([offline, offline]));
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ bufferedChunks: 0, strandedChunks: 0 }));
  });

  it('claims the lease before the first start, so a new device uploads its first epoch', async () => {
    const h = harness({ unclaimed: true });
    await h.engine.start();
    expect(h.calls.heartbeat).toHaveLength(1);
    h.feed(1.2);
    const { start } = h.lives[0]!.options;
    expect(start.lease_generation).toBe(1);
    await vi.waitFor(() => expect(h.calls.put.map((manifest) => manifest.epoch_id)).toEqual([start.epoch_id]));
    expect(h.snapshot()).toMatchObject({ bufferedChunks: 0, strandedChunks: 0 });
  });

  it('uploads audio recorded under the lease with its own generation and strands audio recorded after the loss', async () => {
    const h = harness({ stored: true });
    h.setOffline(true);
    await h.engine.start();
    h.feed(1.2);
    const held = h.lives[0]!.options.start.epoch_id;
    vi.setSystemTime(Date.now() + 2_000); // the takeover comes after this audio ends
    h.setOwner(false);
    h.setOffline(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.snapshot()).toMatchObject({ listener: 'degraded', issue: 'lease_lost', epochId: null });

    h.feed(1.2);
    await settle();
    const after = h.snapshot().epochId!;
    await h.engine.pause();
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ bufferedChunks: 0, strandedChunks: 2 }));
    expect(h.calls.put.map((manifest) => manifest.epoch_id)).toEqual([held, held]);
    const archived = new Map<string, typeof StartMessage.Type>(h.lives.filter((live) => live.options.start.archive_only).map((live) => [live.options.start.epoch_id, live.options.start]));
    expect(archived.get(held)).toMatchObject({ lease_generation: 1, end_reason: 'lease_lost' });
    expect(archived.get(after)).toMatchObject({ lease_generation: 1, end_reason: 'pause' });
    expect([...h.buffer.chunks.values()].map((chunk) => chunk.manifest.epoch_id)).toEqual([after, after]); // never deleted
  });

  it('registers an epoch paused while offline and uploads it after reconnect', async () => {
    const h = harness({ stored: true });
    h.setOffline(true);
    await h.engine.start();
    h.feed(1.2);
    const offline = h.lives[0]!.options.start.epoch_id;
    await h.engine.pause();
    await settle();
    expect(h.calls.put).toEqual([]);
    expect(h.snapshot()).toMatchObject({ bufferedChunks: 2, strandedChunks: 0 }); // waiting, not refused

    h.setOffline(false);
    h.win.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(h.calls.put.map((manifest) => manifest.epoch_id)).toEqual([offline, offline]));
    expect(h.lives.at(-1)!.options.start).toMatchObject({ epoch_id: offline, lease_generation: 1, archive_only: true, end_reason: 'pause', sample_end: expect.any(Number) });
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ bufferedChunks: 0, strandedChunks: 0 }));
    expect(h.buffer.starts.has(offline)).toBe(false);
  });

  it('registers the epoch a sleep re-anchor left offline without ending the current one', async () => {
    const h = harness({ stored: true });
    h.setOffline(true);
    await h.engine.start();
    h.feed(1.2);
    const slept = h.lives[0]!.options.start.epoch_id;
    vi.setSystemTime(Date.now() + 10 * 60_000);
    h.feed(0.1);
    await settle();
    const woke = h.snapshot().epochId;
    expect(woke).not.toBe(slept);

    h.setOffline(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(h.calls.put.map((manifest) => manifest.epoch_id)).toEqual([slept, slept]));
    expect(h.lives.filter((live) => live.options.start.archive_only).map((live) => live.options.start)).toContainEqual(expect.objectContaining({ epoch_id: slept, end_reason: 'close' }));
    expect(h.snapshot().epochId).toBe(woke);
    expect(h.lives[1]).toMatchObject({ options: { start: { epoch_id: woke } } });
    expect(h.lives[1]).not.toHaveProperty('stopped');
  });

  it('registers an epoch recorded offline before a tab close and uploads it on the next load', async () => {
    const closed = harness({ stored: true });
    closed.setOffline(true);
    await closed.engine.start();
    closed.feed(0.6);
    const epoch = closed.lives[0]!.options.start.epoch_id;
    closed.win.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(closed.buffer.chunks.size).toBe(1));
    closed.engine.dispose();
    expect(closed.calls.put).toEqual([]);

    closed.buffer.orphans = 1;
    const reloaded = harness({ buffer: closed.buffer, stored: true });
    await vi.waitFor(() => expect(reloaded.calls.put.map((manifest) => manifest.epoch_id)).toEqual([epoch]));
    expect(reloaded.lives.map((live) => live.options.start)).toMatchObject([{ epoch_id: epoch, lease_generation: 1, archive_only: true }]);
    expect(reloaded.lives[0]!.options.start).toMatchObject({ end_reason: 'interrupted' });
    await vi.waitFor(() => expect(reloaded.snapshot()).toMatchObject({ listener: 'stopped', archive: 'interrupted', bufferedChunks: 0, strandedChunks: 0 }));
  });

  it('keeps audio the server refuses after a takeover as stranded local audio', async () => {
    const h = harness({ stored: true });
    h.setOffline(true);
    await h.engine.start();
    h.feed(1.2);
    await h.engine.pause();
    h.setOwner(false); // another device took the listener over before this audio ended
    h.setOffline(false);
    h.win.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ bufferedChunks: 0, strandedChunks: 2 }));
    expect(h.calls.put).toEqual([]);
    expect(h.buffer.chunks.size).toBe(2); // never deleted
  });

  it('honours a pause pressed while the microphone prompt is open', async () => {
    let grant: (stream: MediaStream) => void = () => { };
    const track = new FakeTrack();
    const h = harness({ getUserMedia: () => new Promise<MediaStream>((resolve) => (grant = resolve)) });
    const starting = h.engine.start();
    await settle();
    expect(h.snapshot().listener).toBe('starting');
    await h.engine.pause();
    grant({ getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream);
    await starting;
    expect(h.snapshot()).toMatchObject({ listener: 'paused', permission: 'granted' });
    expect(track.readyState).toBe('ended');
    expect(h.lives).toHaveLength(0);
  });

  it('refuses a second capture in the same browser', async () => {
    const locks = new FakeLocks();
    const first = harness({ locks });
    await first.engine.start();
    const second = harness({ locks });
    await second.engine.start();
    expect(second.snapshot()).toMatchObject({ listener: 'stopped', issue: 'lease_lost' });
  });

  it('pauses visibly when storage is full and marks audio missing when storage is cleared', async () => {
    const full = new MemoryBuffer();
    full.appendPart = () => Promise.reject(new StorageError('full'));
    const h = harness({ buffer: full });
    await h.engine.start();
    h.feed(0.6);
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ listener: 'paused', issue: 'storage_full' }));
    expect(h.snapshot().archive).not.toBe('interrupted');

    const cleared = harness();
    await cleared.engine.start();
    cleared.buffer.onLost();
    await vi.waitFor(() => expect(cleared.snapshot()).toMatchObject({ listener: 'paused', archive: 'missing', issue: 'storage_unavailable' }));
  });
});
