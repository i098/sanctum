import { NotFound, type RecordingChunkManifest, type RecordingChunkReceipt } from '@sanctum/contracts';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  freeBytes = 1e9;
  onLost = () => { };
  async appendPart(part: PartRecord) {
    this.parts.push(part);
  }
  async sealChunk(chunk: SealedChunk) {
    this.chunks.set(chunk.manifest.chunk_id, chunk);
  }
  readonly refused = new Set<string>();
  async nextPending(listenerId: string) {
    return [...this.chunks.values()].find((chunk) => chunk.manifest.listener_id === listenerId && !this.refused.has(chunk.manifest.chunk_id)) ?? null;
  }
  async markRefused(chunkId: string) {
    this.refused.add(chunkId);
  }
  async acknowledge(manifest: RecordingChunkManifest) {
    this.chunks.delete(manifest.chunk_id);
  }
  async countChunks(listenerId: string | null) {
    const pending = [...this.chunks.values()].filter((chunk) => chunk.manifest.listener_id === listenerId && !this.refused.has(chunk.manifest.chunk_id)).length;
    return { pending, stranded: this.chunks.size - pending };
  }
  async savedThroughMs() {
    return null;
  }
  async recoverOrphans() {
    return this.orphans;
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
  const storage = new Map<string, string>(options.stored ? [['sanctum.listener', JSON.stringify({ id: LISTENER_ID, lease_generation: 3 })]] : []);
  const lives: Array<{ options: LiveOptions; sent: number[]; stopped: StopReason | null }> = [];
  const calls = { register: 0, heartbeat: [] as unknown[], put: [] as RecordingChunkManifest[] };
  let owner = true;
  let generation = 1;
  /** The server forgot LISTENER_ID: its heartbeat and uploads fail NotFound, and registration issues a new id. */
  let forgotten = false;
  /** Epochs the server inserted from a `start` carrying the current lease; chunks of any other epoch are NotFound. */
  const epochs = new Set(options.epochs);
  const unknown = () => Effect.fail(new NotFound({ message: 'listener not found' }));
  let onBlock: ((start: number, samples: Int16Array) => void) | null = null;
  const receipt = (manifest: RecordingChunkManifest) =>
    ({ chunk_id: manifest.chunk_id, object_key: 'k', sha256: manifest.sha256, byte_length: manifest.byte_length, committed_at: '2026-09-29T09:00:00Z' }) as RecordingChunkReceipt;
  const client = {
    registerListener: () => {
      calls.register++;
      return Effect.succeed({ id: forgotten ? NEXT_LISTENER_ID : LISTENER_ID, lease_generation: options.unclaimed ? 0 : 1 });
    },
    heartbeat: (request: { path: { listener_id: string }; payload: unknown }) => {
      calls.heartbeat.push(request.payload);
      if (forgotten && request.path.listener_id === LISTENER_ID) return unknown();
      return Effect.succeed({ lease_generation: generation, lease_expires_at: '2026-09-29T09:00:45Z', owner });
    },
    putChunk: (request: { headers: { 'x-sanctum-manifest': RecordingChunkManifest } }) => {
      const manifest = request.headers['x-sanctum-manifest'];
      if (forgotten && manifest.listener_id === LISTENER_ID) return unknown();
      if (!epochs.has(manifest.epoch_id)) return Effect.fail(new NotFound({ message: 'Capture epoch not found for this listener' }));
      calls.put.push(manifest);
      return Effect.succeed(receipt(manifest));
    },
  } as unknown as ListenersClient;
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
    openLive: (liveOptions): LiveStream => {
      const live = { options: liveOptions, sent: [] as number[], stopped: null as StopReason | null };
      lives.push(live);
      if (owner && liveOptions.start.lease_generation === generation) epochs.add(liveOptions.start.epoch_id);
      liveOptions.onStatus('connecting');
      return { send: (start) => void live.sent.push(start), stop: (reason) => void (live.stopped = reason) };
    },
    streamUrl: (id) => `ws://test/api/v1/listeners/${id}/stream`,
    timing: { chunkSeconds: 1, commitSeconds: 0.5, heartbeatMs: 15_000, gapMs: 3_000 },
  };
  const engine = createCaptureController(deps);
  let next = 0;
  const feed = (seconds: number) => {
    for (let i = 0; i < (seconds * RATE) / BLOCK; i++, next += BLOCK) onBlock!(next, new Int16Array(BLOCK).fill(100));
  };
  const accept = () => lives.at(-1)!.options.onStatus('live');
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
    snapshot,
    setOwner: (value: boolean) => {
      if (!value && owner) generation++;
      owner = value;
    },
    forget: () => {
      forgotten = true;
    },
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
    expect(h.lives[0]!.stopped).toBe('close');
  });

  it('keeps capturing while overlays subscribe and unsubscribe', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.accept();
    const overlay = h.engine.subscribe(() => {});
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
    expect(closed.lives[0]!.stopped).toBe('close');

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
    expect(h.snapshot()).toMatchObject({ listener: 'degraded', issue: 'lease_lost' });
    expect(h.lives[0]!.stopped).toBe('close');
    expect(h.calls.heartbeat.at(-1)).toMatchObject({ lease_generation: 1, state: 'listening', buffered_chunks: 0 });
  });

  it('reopens the live stream in a new epoch when ownership comes back', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.accept();
    h.setOwner(false);
    await vi.advanceTimersByTimeAsync(15_000);
    h.setOwner(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.snapshot()).toMatchObject({ listener: 'starting', issue: null });
    h.feed(0.1);
    expect(h.lives).toHaveLength(2);
    expect(h.lives[1]!.options.start.epoch_id).not.toBe(h.lives[0]!.options.start.epoch_id);
    expect(h.lives[1]!.options.start.lease_generation).toBe(2);
    h.accept();
    await settle();
    expect(h.snapshot()).toMatchObject({ listener: 'listening', epochId: h.lives[1]!.options.start.epoch_id });
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

  it('keeps audio recorded without the lease as not uploadable and still uploads later epochs', async () => {
    const h = harness();
    h.setOwner(false);
    await h.engine.start();
    expect(h.snapshot()).toMatchObject({ listener: 'degraded', issue: 'lease_lost' });
    h.feed(1.2);
    await settle();
    const orphaned = h.snapshot().epochId;
    expect(h.lives).toHaveLength(0);

    h.setOwner(true);
    await vi.advanceTimersByTimeAsync(15_000);
    h.feed(1.2);
    const accepted = h.lives[0]!.options.start.epoch_id;
    await vi.waitFor(() => expect(h.calls.put.map((manifest) => manifest.epoch_id)).toEqual([accepted]));
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ archive: 'capturing', bufferedChunks: 0, strandedChunks: 2 }));
    expect([...h.buffer.chunks.values()].map((chunk) => chunk.manifest.epoch_id)).toEqual([orphaned, orphaned]); // never deleted
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
