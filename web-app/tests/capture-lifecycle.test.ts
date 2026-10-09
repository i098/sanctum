import { NotFound, Unauthenticated, Unavailable, type RecordingChunkManifest, type RecordingChunkReceipt, type StartMessage } from '@sanctum/contracts';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpochEnd } from '../src/lib/capture/buffer.ts';
import type { ListenersClient } from '../src/lib/capture/client.ts';
import { createCaptureController, type CaptureBuffer, type CaptureDeps } from '../src/lib/capture/controller.ts';
import type { LiveOptions, LiveStream, StopReason } from '../src/lib/capture/live.ts';
import { groupRecordings } from '../src/lib/capture/orphans.ts';
import { sealChunk, StorageError, type PartRecord, type SealedChunk } from '../src/lib/capture/recorder.ts';
import type { CaptureView } from '../src/lib/capture/view.ts';

const LISTENER_ID = '5f0d6f0e-8c1b-4b8e-a4f3-2d9c7a1e4b01';
/** Registered after the server forgot LISTENER_ID. */
const NEXT_LISTENER_ID = '9a4e2b1c-3d5f-4e6a-8b7c-0d1e2f3a4b5c';
const RATE = 48_000;
const BLOCK = 2_400;

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = 'live';
  label = 'Default - MacBook Pro Microphone';
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
  async countChunks(uploadable: readonly string[]) {
    const counts = { pending: 0, refused: 0, stranded: 0 };
    for (const { manifest } of this.chunks.values()) {
      if (uploadable.includes(manifest.listener_id)) void (this.refused.has(manifest.chunk_id) ? counts.refused++ : counts.pending++);
      else counts.stranded++;
    }
    return counts;
  }
  async orphanedRecordings(uploadable: readonly string[], maxSamples?: number) {
    const manifests = [...this.chunks.values()].map(({ manifest }) => manifest);
    return groupRecordings(manifests.filter((manifest) => !uploadable.includes(manifest.listener_id)), maxSamples);
  }
  async recordingSegments() {
    return [];
  }
  async discardRecording(listenerId: string, epochId: string, uploadable: readonly string[]) {
    if (uploadable.includes(listenerId)) return;
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
  async query() {
    return { held: this.held ? [{ name: 'sanctum-capture', mode: 'exclusive' as const }] : [] };
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

  constructor(options: { unclaimed?: boolean; epochs?: string[]; signedOut?: boolean }) {
    this.options = options;
    this.generation = options.unclaimed ? 0 : 1;
    this.active = !options.unclaimed;
    this.claims = options.unclaimed ? [] : [{ generation: 1, at: 0 }];
    this.epochs = new Map((options.epochs ?? []).map((id) => [id, 1]));
    if (options.signedOut) this.expire();
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

  /** The owner session ends: every later request is refused as unauthenticated. */
  readonly expire = () => {
    const refuse = () => Effect.fail(new Unauthenticated({ message: 'No credentials' }));
    Object.assign(this.client, {
      registerListener: () => {
        this.calls.register++;
        return refuse();
      },
      heartbeat: refuse,
      putChunk: refuse,
    });
  };
}

/** The captain's inputs: the closed MacBook's built-in microphone is the default, an iPhone through Continuity and a virtual device are the others. */
const INPUTS: Record<string, string> = { default: 'Default - MacBook Pro Microphone', builtin: 'MacBook Pro Microphone', iphone: '萧 Microphone', loom: 'LoomAudioDevice' };

function harness(options: { secure?: boolean; getUserMedia?: () => Promise<MediaStream>; buffer?: MemoryBuffer; locks?: FakeLocks; stored?: boolean; unclaimed?: boolean; epochs?: string[]; signedOut?: boolean; input?: string } = {}) {
  const win = Object.assign(new EventTarget(), { isSecureContext: options.secure ?? true });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const tracks: FakeTrack[] = [];
  const inputs = { ...INPUTS };
  /** Every `getUserMedia` audio request, in order. */
  const requests: MediaTrackConstraints[] = [];
  const microphone = async (constraints: MediaStreamConstraints) => {
    const audio = constraints.audio as MediaTrackConstraints;
    requests.push(audio);
    const label = inputs[((audio.deviceId as ConstrainDOMStringParameters | undefined)?.exact as string | undefined) ?? 'default'];
    if (label === undefined) throw new DOMException('no such input', 'OverconstrainedError');
    const track = tracks[tracks.push(Object.assign(new FakeTrack(), { label })) - 1];
    return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  };
  const status = new FakeStatus();
  const sentinels: FakeSentinel[] = [];
  const buffer = options.buffer ?? new MemoryBuffer();
  const storage = new Map<string, string>(options.stored ? [['sanctum.listener', JSON.stringify({ id: LISTENER_ID, lease_generation: 1 })]] : []);
  if (options.input) storage.set('sanctum.microphone', options.input);
  /** Streams the recorder was moved to without a restart. */
  const replaced: MediaStream[] = [];
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
      return { sampleRate: RATE, levels: { bandCount: 33, read: (bands) => (bands.fill(0.5), 0.5) }, flush: async () => { }, replaceInput: (stream) => void replaced.push(stream), close: async () => { } };
    },
    client,
    openLive: server.openLive,
    streamUrl: (id) => `ws://test/api/v1/listeners/${id}/stream`,
    timing: { chunkSeconds: 1, commitSeconds: 0.5, heartbeatMs: 15_000, gapMs: 3_000, silentSeconds: 1 },
  };
  const engine = createCaptureController(deps);
  let next = 0;
  /** `sample`: every PCM16 value fed; 0 is a dead input, small values a quiet room. */
  const feed = (seconds: number, sample = 100) => {
    for (let i = 0; i < (seconds * RATE) / BLOCK; i++, next += BLOCK) onBlock!(next, new Int16Array(BLOCK).fill(sample));
  };
  const accept = () => lives.at(-1)!.options.onStatus('live');
  const reject = (reason: 'stale_generation' | 'unauthorized' = 'stale_generation') => lives.at(-1)!.options.onStatus('rejected', reason);
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
    inputs,
    requests,
    replaced,
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
    expire: server.expire,
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

/** Chunks the Settings list of removed-listener recordings shows, or null while it only notes that capture runs. */
const listedChunks = async ({ engine }: { engine: CaptureView }) => (await engine.orphanedRecordings())?.reduce((sum, recording) => sum + recording.chunkCount, 0) ?? null;

/** With no tab capturing, the Settings list and the footer's stranded count describe the same chunks. */
const expectAgreement = async (h: { engine: CaptureView }) => expect(await listedChunks(h)).toBe(h.engine.getSnapshot().strandedChunks);

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

  it('asks for one raw mono stream: echo cancellation on, no noise suppression or gain control', async () => {
    // Whisper and the archive get the unprocessed microphone; the waveform filters noise itself.
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException('no', 'NotFoundError')));
    await harness({ getUserMedia }).engine.start();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
  });

  it('reports a missing session as signed out, not as a server connection failure', async () => {
    const h = harness({ signedOut: true });
    await h.engine.start();
    expect(h.calls.register).toBe(1);
    expect(h.snapshot()).toMatchObject({ listener: 'stopped', issue: 'signed_out', archive: null });
  });

  it('reports an expired session as signed out when the device already has a stored listener', async () => {
    const getUserMedia = vi.fn();
    const h = harness({ stored: true, signedOut: true, getUserMedia });
    await h.engine.start();
    expect(h.calls.register).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(h.snapshot()).toMatchObject({ listener: 'stopped', issue: 'signed_out', archive: null });
    expect(h.lives).toHaveLength(0);
  });

  it('stops a running capture as signed out when the session expires', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.accept();
    h.expire();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ listener: 'paused', issue: 'signed_out' }));
    expect(h.track.readyState).toBe('ended');
  });

  it('reports a live socket refused for a missing session as signed out', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.reject('unauthorized');
    expect(h.snapshot().issue).toBe('signed_out');
  });

  it('reports buffered audio refused for a missing session as signed out', async () => {
    const buffer = new MemoryBuffer();
    await buffer.sealChunk(
      await sealChunk(
        { chunk_id: crypto.randomUUID(), listener_id: LISTENER_ID, epoch_id: crypto.randomUUID(), sequence: 0, sample_rate: RATE, chunk_start: 0, captured_at: '2026-09-29T08:59:00.000Z' },
        new Int16Array(RATE),
      ),
    );
    const h = harness({ buffer, stored: true, signedOut: true });
    await vi.waitFor(() => expect(h.snapshot().issue).toBe('signed_out'));
    expect(h.snapshot().bufferedChunks).toBe(1);
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

  it('warns, naming the input, after it sends exact zero for the threshold, and clears at the first real sound', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.accept();
    h.feed(0.9, 0);
    expect(h.snapshot()).toMatchObject({ listener: 'listening', issue: null });
    h.feed(0.1, 0);
    expect(h.snapshot()).toMatchObject({ listener: 'degraded', issue: 'silent_input', inputLabel: 'Default - MacBook Pro Microphone' });
    h.feed(0.05, 2);
    expect(h.snapshot()).toMatchObject({ listener: 'listening', issue: null });
  });

  it('never warns about a quiet room, whose noise is never exact zero', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.accept();
    h.feed(1.5, 2);
    expect(h.snapshot()).toMatchObject({ listener: 'listening', issue: null });
  });

  it('moves a running capture to the chosen input in the same epoch, and remembers the choice for the next page', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.accept();
    h.feed(1, 0);
    const { epochId } = h.snapshot();
    const dead = h.track;
    await h.engine.chooseInput('iphone');
    expect(h.requests.at(-1)).toMatchObject({ deviceId: { exact: 'iphone' } });
    expect(h.replaced).toHaveLength(1);
    expect(dead.readyState).toBe('ended');
    expect(h.snapshot()).toMatchObject({ listener: 'listening', issue: null, epochId, inputId: 'iphone', inputLabel: '萧 Microphone' });
    expect(h.lives).toHaveLength(1);
    expect(h.storage.get('sanctum.microphone')).toBe('iphone');

    const next = harness({ input: 'iphone' });
    expect(next.snapshot().inputId).toBe('iphone');
    await next.engine.start();
    expect(next.requests).toMatchObject([{ deviceId: { exact: 'iphone' } }]);
  });

  it('falls back to the default input when the chosen one is gone, and says so', async () => {
    const h = harness({ input: 'iphone' });
    delete h.inputs['iphone'];
    await h.engine.start();
    expect(h.requests.map(({ deviceId }) => deviceId)).toEqual([{ exact: 'iphone' }, undefined]);
    expect(h.snapshot()).toMatchObject({ issue: 'input_unavailable', inputId: null, inputLabel: 'Default - MacBook Pro Microphone' });
    expect(h.storage.has('sanctum.microphone')).toBe(false);

    // A chosen input unplugged during capture hands the same epoch to the default input.
    h.feed(0.1);
    h.accept();
    h.inputs['loom'] = 'LoomAudioDevice';
    await h.engine.chooseInput('loom');
    const { epochId } = h.snapshot();
    expect(h.snapshot()).toMatchObject({ issue: null, inputId: 'loom' });
    h.track.unplug();
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ listener: 'listening', issue: 'input_unavailable', inputId: null, inputLabel: 'Default - MacBook Pro Microphone', epochId }));

    // An input that cannot open leaves capture on the current one.
    delete h.inputs['loom'];
    await h.engine.chooseInput('loom');
    expect(h.snapshot()).toMatchObject({ listener: 'listening', issue: 'unsupported_constraints', inputId: null, inputLabel: 'Default - MacBook Pro Microphone' });
  });

  it('shows a failed input switch at once while the input is silent, and never again once sound returns', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.accept();
    h.feed(1, 0);
    expect(h.snapshot().issue).toBe('silent_input');
    await h.engine.chooseInput('iphone-gone');
    expect(h.snapshot()).toMatchObject({ listener: 'degraded', issue: 'unsupported_constraints', inputId: null });
    h.feed(0.05, 2);
    expect(h.snapshot()).toMatchObject({ listener: 'listening', issue: null });
    h.feed(1, 0);
    expect(h.snapshot().issue).toBe('silent_input');
    await h.engine.chooseInput('iphone');
    expect(h.snapshot()).toMatchObject({ listener: 'listening', issue: null, inputId: 'iphone' });
  });

  it('drops the fallback input note once sound arrives, so transcription trouble shows', async () => {
    const h = harness({ input: 'iphone' });
    delete h.inputs['iphone'];
    await h.engine.start();
    expect(h.snapshot().issue).toBe('input_unavailable');
    h.feed(0.1);
    h.accept();
    expect(h.snapshot().issue).toBeNull();
    h.lives[0]!.options.onStatus('degraded', 'provider_unavailable');
    expect(h.snapshot()).toMatchObject({ listener: 'degraded', issue: 'transcription_unavailable' });
  });

  it('names lost live transcription while capture continues, and drops it once the stream reconnects', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.1);
    h.accept();
    h.lives[0]!.options.onStatus('degraded', 'provider_unavailable');
    expect(h.snapshot()).toMatchObject({ listener: 'degraded', issue: 'transcription_unavailable', archive: 'capturing' });
    h.lives[0]!.options.onStatus('reconnecting');
    expect(h.snapshot()).toMatchObject({ listener: 'reconnecting', issue: null });
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

  it('End pauses like Pause, even before the live socket accepts, and resolves with the last sample captured in the epoch, or null when none is open', async () => {
    const h = harness();
    expect(await h.engine.end()).toBeNull();
    await h.engine.start();
    h.feed(0.3);
    expect(h.snapshot().listener).toBe('starting'); // the live socket has not accepted yet
    const epoch_id = h.lives[0]!.options.start.epoch_id;
    expect(await h.engine.end()).toEqual({ epoch_id, sample: BLOCK * 6 });
    expect(h.snapshot()).toMatchObject({ listener: 'paused', epochId: null });
    expect(h.lives[0]!.stopped).toBe('pause');
  });

  it('fences a resumed epoch at its own sample count, not the recorder index', async () => {
    const h = harness();
    await h.engine.start();
    h.feed(0.3);
    await h.engine.end();
    await h.engine.resume();
    h.feed(0.1);
    expect(await h.engine.end()).toEqual({ epoch_id: h.lives[1]!.options.start.epoch_id, sample: BLOCK * 2 });
    expect(await h.engine.end()).toEqual({ epoch_id: h.lives[1]!.options.start.epoch_id, sample: BLOCK * 2 });
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
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ archive: null, bufferedChunks: 0, refusedChunks: 0, strandedChunks: 1 })); // the failed upload asks the heartbeat, which learns the server no longer knows the listener
    expect(h.storage.has('sanctum.listener')).toBe(false);
    await expectAgreement(h);

    await h.engine.start();
    h.feed(1.2);
    await vi.waitFor(() => expect(h.calls.put.map((manifest) => manifest.listener_id)).toEqual([NEXT_LISTENER_ID]));
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ bufferedChunks: 0, strandedChunks: 1 }));
    expect(await listedChunks(h)).toBeNull(); // listed only once capture stops
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.calls.heartbeat.at(-1)).toMatchObject({ buffered_chunks: 0 });
    expect(h.buffer.chunks.get(old.manifest.chunk_id)).toBe(old); // never deleted
    await h.engine.pause();
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ bufferedChunks: 0, strandedChunks: 1 }));
    await expectAgreement(h);
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

  it('stops capture when the server removes this device\'s listener, and lists its recording once stopped', async () => {
    const h = harness({ stored: true });
    await h.engine.start();
    h.forget();
    h.feed(0.6); // no chunk is sealed, so only the heartbeat can learn of the removal
    await settle();
    const epochId = h.snapshot().epochId!;
    await vi.advanceTimersByTimeAsync(15_000); // the heartbeat learns the server removed the listener
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ listener: 'paused', issue: 'listener_removed', epochId: null, bufferedChunks: 0, refusedChunks: 0 }));
    expect(h.track.readyState).toBe('ended');
    expect(h.buffer.starts.get(epochId)).toMatchObject({ end_reason: 'close' });
    const kept = h.buffer.chunks.size;
    h.feed(1.2);
    await settle();
    expect(h.buffer.chunks.size).toBe(kept); // no audio is recorded under a removed listener
    expect(h.snapshot().strandedChunks).toBe(kept);
    expect((await h.engine.orphanedRecordings())!.map((recording) => recording.epochId)).toEqual([epochId]);
    await expectAgreement(h);
    expect(h.calls.put).toEqual([]);

    await h.engine.resume(); // only a person restarts capture, under a newly registered listener
    expect(h.calls.register).toBe(1);
    expect(h.snapshot()).toMatchObject({ issue: null, strandedChunks: kept });
    expect(JSON.parse(h.storage.get('sanctum.listener')!)).toMatchObject({ id: NEXT_LISTENER_ID });
  });

  it('stops capture as soon as an upload finds the listener removed, without waiting for the heartbeat', async () => {
    const h = harness({ stored: true });
    await h.engine.start();
    h.forget();
    h.feed(1.2); // the sealed chunk's upload fails NotFound
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ listener: 'paused', issue: 'listener_removed', epochId: null }));
    expect(h.track.readyState).toBe('ended');
  });

  it('lists recordings of removed listeners for export or discard only while no tab captures', async () => {
    const buffer = new MemoryBuffer();
    const old = await sealChunk(
      { chunk_id: crypto.randomUUID(), listener_id: LISTENER_ID, epoch_id: crypto.randomUUID(), sequence: 0, sample_rate: RATE, chunk_start: 0, captured_at: '2026-09-29T08:59:00.000Z' },
      new Int16Array(RATE),
    );
    await buffer.sealChunk(old);
    const locks = new FakeLocks();
    const idle = harness({ buffer, locks });
    await settle();
    const recorder = harness({ buffer, locks });
    await settle();
    recorder.forget(); // its start registers a new listener
    await recorder.engine.start();
    const recording = { listenerId: LISTENER_ID, epochId: old.manifest.epoch_id, sampleRate: RATE, startedAt: old.manifest.captured_at, sampleCount: RATE, chunkCount: 1, parts: [] };
    for (const tab of [idle, recorder]) {
      expect(tab.snapshot()).toMatchObject({ bufferedChunks: 0, refusedChunks: 0, strandedChunks: 1 });
      expect(await tab.engine.orphanedRecordings()).toBeNull();
      await expect(tab.engine.discardRecording(recording)).rejects.toThrow('capture is running; stop it before discarding');
    }
    expect(buffer.chunks.has(old.manifest.chunk_id)).toBe(true);

    await recorder.engine.pause();
    for (const tab of [idle, recorder]) {
      expect((await tab.engine.orphanedRecordings())!.map((listed) => listed.epochId)).toEqual([old.manifest.epoch_id]);
      await expectAgreement(tab);
    }
    await idle.engine.discardRecording(recording);
    expect(buffer.chunks.has(old.manifest.chunk_id)).toBe(false);
    expect(idle.snapshot().strandedChunks).toBe(0);
  });

  it('counts and lists removed-listener recordings in a tab that loaded while another tab captured', async () => {
    const buffer = new MemoryBuffer();
    const old = await sealChunk(
      { chunk_id: crypto.randomUUID(), listener_id: LISTENER_ID, epoch_id: crypto.randomUUID(), sequence: 0, sample_rate: RATE, chunk_start: 0, captured_at: '2026-09-29T08:59:00.000Z' },
      new Int16Array(RATE),
    );
    await buffer.sealChunk(old);
    const locks = new FakeLocks();
    const recorder = harness({ buffer, locks });
    await settle();
    recorder.forget();
    await recorder.engine.start();
    const late = harness({ buffer, locks });
    await settle();
    expect(await late.engine.orphanedRecordings()).toBeNull();
    expect(late.snapshot().strandedChunks).toBe(1);

    await recorder.engine.pause();
    expect((await late.engine.orphanedRecordings())!.map((listed) => listed.epochId)).toEqual([old.manifest.epoch_id]);
    await expectAgreement(late);
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

    const recording = (chunk: SealedChunk) => ({ listenerId: chunk.manifest.listener_id, epochId: chunk.manifest.epoch_id, sampleRate: RATE, startedAt: chunk.manifest.captured_at, sampleCount: RATE, chunkCount: 1, parts: [] });
    await h.engine.discardRecording(recording(pending));
    await h.engine.discardRecording(recording(removed));
    expect([...buffer.chunks.keys()]).toEqual([pending.manifest.chunk_id]);
  });

  it('never discards pending audio of its own listener after another tab cleared the shared record', async () => {
    const buffer = new MemoryBuffer();
    const h = harness({ buffer, stored: true });
    await settle();
    const pending = await sealChunk(
      { chunk_id: crypto.randomUUID(), listener_id: LISTENER_ID, epoch_id: crypto.randomUUID(), sequence: 0, sample_rate: RATE, chunk_start: 0, captured_at: '2026-09-29T08:59:00.000Z' },
      new Int16Array(RATE),
    );
    await buffer.sealChunk(pending);
    h.storage.delete('sanctum.listener'); // a stale tab learned its older listener was removed

    await h.engine.discardRecording({ listenerId: LISTENER_ID, epochId: pending.manifest.epoch_id, sampleRate: RATE, startedAt: pending.manifest.captured_at, sampleCount: RATE, chunkCount: 1, parts: [] });
    expect([...buffer.chunks.keys()]).toEqual([pending.manifest.chunk_id]);
  });

  it('records under the listener another tab registered after this one loaded instead of registering a second one', async () => {
    const buffer = new MemoryBuffer();
    const h = harness({ buffer });
    await settle();
    h.storage.set('sanctum.listener', JSON.stringify({ id: LISTENER_ID, lease_generation: 1 })); // another tab registered, recorded and paused offline with uploads pending
    const pending = await sealChunk(
      { chunk_id: crypto.randomUUID(), listener_id: LISTENER_ID, epoch_id: crypto.randomUUID(), sequence: 0, sample_rate: RATE, chunk_start: 0, captured_at: '2026-09-29T08:59:00.000Z' },
      new Int16Array(RATE),
    );
    await buffer.sealChunk(pending);
    h.setOffline(true);
    await h.engine.start();
    h.feed(0.1);
    expect(h.calls.register).toBe(0);
    expect(h.lives.at(-1)!.options.start.listener_id).toBe(LISTENER_ID);
    expect(JSON.parse(h.storage.get('sanctum.listener')!)).toMatchObject({ id: LISTENER_ID });
    await h.engine.pause();
    expect(await h.engine.orphanedRecordings()).toEqual([]);
    await h.engine.discardRecording({ listenerId: LISTENER_ID, epochId: pending.manifest.epoch_id, sampleRate: RATE, startedAt: pending.manifest.captured_at, sampleCount: RATE, chunkCount: 1, parts: [] });
    expect(buffer.chunks.has(pending.manifest.chunk_id)).toBe(true);
  });

  it('keeps the listener another tab registered when this tab learns its older listener was removed', async () => {
    const buffer = new MemoryBuffer();
    const h = harness({ buffer, stored: true });
    await settle();
    const pending = await sealChunk(
      { chunk_id: crypto.randomUUID(), listener_id: NEXT_LISTENER_ID, epoch_id: crypto.randomUUID(), sequence: 0, sample_rate: RATE, chunk_start: 0, captured_at: '2026-09-29T08:59:00.000Z' },
      new Int16Array(RATE),
    );
    await buffer.sealChunk(pending);
    const next = JSON.stringify({ id: NEXT_LISTENER_ID, lease_generation: 1 });
    h.storage.set('sanctum.listener', next); // another tab registered after the old listener was removed
    h.forget();
    await vi.advanceTimersByTimeAsync(15_000); // this tab's heartbeat for the old listener fails NotFound
    expect(h.storage.get('sanctum.listener')).toBe(next);

    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ bufferedChunks: 1, refusedChunks: 0, strandedChunks: 0 })); // the other tab's audio is still uploadable
    await expectAgreement(h);
    await h.engine.discardRecording({ listenerId: NEXT_LISTENER_ID, epochId: pending.manifest.epoch_id, sampleRate: RATE, startedAt: pending.manifest.captured_at, sampleCount: RATE, chunkCount: 1, parts: [] });
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
    const lossBeat = h.calls.heartbeat.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.snapshot()).toMatchObject({ listener: 'degraded', issue: 'lease_lost', epochId: null });
    expect(h.lives[0]!.stopped).toBe('close');
    // The beat that learned of the other owner; the sealed tail's refused upload may beat again, on real-time hashing.
    expect(h.calls.heartbeat[lossBeat]).toMatchObject({ lease_generation: 1, state: 'listening', buffered_chunks: 0 });
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
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ bufferedChunks: 0, refusedChunks: 2, strandedChunks: 0 }));
    expect(await listedChunks(h)).toBe(0);
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

  it('keeps audio the server refuses after a takeover as refused local audio', async () => {
    const h = harness({ stored: true });
    h.setOffline(true);
    await h.engine.start();
    h.feed(1.2);
    await h.engine.pause();
    h.setOwner(false); // another device took the listener over before this audio ended
    h.setOffline(false);
    h.win.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(h.snapshot()).toMatchObject({ bufferedChunks: 0, refusedChunks: 2, strandedChunks: 0 }));
    await expectAgreement(h);
    expect(h.calls.put).toEqual([]);
    expect(h.buffer.chunks.size).toBe(2); // never deleted
  });

  it.each(['pause', 'end'] as const)('honours %s pressed while the microphone prompt is open', async (stop) => {
    let grant: (stream: MediaStream) => void = () => { };
    const track = new FakeTrack();
    const h = harness({ getUserMedia: () => new Promise<MediaStream>((resolve) => (grant = resolve)) });
    const starting = h.engine.start();
    await settle();
    expect(h.snapshot().listener).toBe('starting');
    await h.engine[stop]();
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
