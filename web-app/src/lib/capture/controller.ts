/**
 * Capture lifecycle (plan 05 and 14). One controller owns the microphone, recorder, recovery
 * buffer, live stream, uploads and heartbeat, independent of any overlay or route, and
 * publishes low-rate semantic state through `createCaptureStore`; waveform levels are read
 * directly. Closing the tab ends capture: the next page load seals what the closed page had
 * committed and reports that capture as interrupted, never as still recording.
 */
import { LeaseGeneration, ListenerId, SampleRate, StartMessage, type CaptureEpochId, type RecordingChunkManifest } from '@sanctum/contracts';
import { Cause, Effect, Exit, Fiber, Option, Schema } from 'effect';
import { RecoveryBuffer } from './buffer.ts';
import { makeListenersClient, type ListenersClient } from './client.ts';
import { openLiveStream, streamUrl, type LiveOptions, type LiveStatus, type LiveStream, type RejectReason, type StopReason } from './live.ts';
import { acquireMicrophone, captureIssue, holdCaptureLock, watchMicrophonePermission } from './permissions.ts';
import { ChunkAssembler, startRecorder, WAVEFORM_BANDS, type Recorder } from './recorder.ts';
import { drainPending, type UploaderOptions } from './uploader.ts';
import { createCaptureStore, type CaptureIssue, type CaptureView, type ListenerState, type LevelSource, type PermissionState } from './view.ts';

/** Browser-side engineering defaults (plan 02); tests shorten them. */
export interface CaptureTiming {
  readonly chunkSeconds: number;
  readonly commitSeconds: number;
  readonly heartbeatMs: number;
  /** Wall-clock time beyond the sample clock that counts as sleep/suspension and starts a new epoch. */
  readonly gapMs: number;
}

const DEFAULT_TIMING: CaptureTiming = { chunkSeconds: 30, commitSeconds: 2, heartbeatMs: 15_000, gapMs: 3_000 };
const LISTENER_KEY = 'sanctum.listener';

export type CaptureBuffer = Pick<
  RecoveryBuffer,
  'appendPart' | 'sealChunk' | 'nextPending' | 'markConflict' | 'acknowledge' | 'countChunks' | 'savedThroughMs' | 'recoverOrphans' | 'persist' | 'close' | 'freeBytes' | 'onLost'
>;

export interface CaptureDeps {
  readonly window?: Pick<Window, 'isSecureContext' | 'addEventListener' | 'removeEventListener'>;
  readonly document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  readonly navigator?: Pick<Navigator, 'mediaDevices' | 'permissions' | 'wakeLock' | 'locks'>;
  readonly localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly openBuffer?: () => Promise<CaptureBuffer>;
  readonly startRecorder?: typeof startRecorder;
  readonly client?: ListenersClient;
  readonly openLive?: (options: LiveOptions) => LiveStream;
  readonly streamUrl?: (listenerId: string) => string;
  readonly timing?: Partial<CaptureTiming>;
  readonly uploader?: UploaderOptions;
  /** Receives requested-speech messages from the live socket (the page wires browser playback here). */
  readonly onSpeech?: LiveOptions['onSpeech'];
}

const StoredListener = Schema.Struct({ id: ListenerId, lease_generation: LeaseGeneration });
type StoredListener = { -readonly [K in keyof typeof StoredListener.Type]: (typeof StoredListener.Type)[K] };
const decodeStored = Schema.decodeUnknownOption(Schema.parseJson(StoredListener));
const decodeStart = Schema.decodeUnknownSync(StartMessage);
const isSampleRate = Schema.is(SampleRate);

interface Epoch {
  readonly id: CaptureEpochId;
  /** Recorder sample index of epoch sample 0. */
  readonly base: number;
  readonly assembler: ChunkAssembler;
  live: LiveStream | null;
  lastWallMs: number;
  lastEnd: number;
}

interface Session {
  readonly stream: MediaStream;
  readonly recorder: Recorder;
  readonly buffer: CaptureBuffer;
  listener: StoredListener;
  readonly releaseLock: () => Promise<void>;
  epoch: Epoch | null;
  stopping: boolean;
}

type Phase = 'stopped' | 'starting' | 'capturing' | 'paused';

class CaptureController implements CaptureView {
  private readonly store = createCaptureStore();
  readonly getSnapshot = this.store.view.getSnapshot;
  readonly subscribe = this.store.view.subscribe;
  readonly levels: LevelSource = {
    bandCount: WAVEFORM_BANDS,
    read: (bands) => (this.session === null ? (bands.fill(0), 0) : this.session.recorder.levels.read(bands)),
  };

  private readonly win: NonNullable<CaptureDeps['window']>;
  private readonly doc: NonNullable<CaptureDeps['document']>;
  private readonly nav: NonNullable<CaptureDeps['navigator']>;
  private readonly storage: NonNullable<CaptureDeps['localStorage']>;
  private readonly client: ListenersClient;
  private readonly timing: CaptureTiming;
  private readonly deps: CaptureDeps;
  private readonly ready: Promise<void>;
  private readonly unlisten: Array<() => void> = [];
  private readonly heartbeat: ReturnType<typeof setInterval>;

  private phase: Phase = 'stopped';
  /** A pause or halt requested while the microphone was still being opened. */
  private cancelStart: 'paused' | 'stopped' | null = null;
  private permission: PermissionState = 'unknown';
  private issue: CaptureIssue | null = null;
  private live: LiveStatus | null = null;
  private muted = false;
  private leaseLost = false;
  private interrupted = false;
  private missing = false;
  private uploading = false;
  private claimed = false;
  private pending = 0;
  /** Local chunks of a listener the server forgot: kept, but never uploadable as they are. */
  private stranded = 0;
  private savedThroughMs: number | null = null;
  private wakeLock: 'unsupported' | 'released' | 'held';
  private sentinel: WakeLockSentinel | null = null;
  private buffer: Promise<CaptureBuffer> | null = null;
  private session: Session | null = null;
  private listener: StoredListener | null;
  private drain: Fiber.RuntimeFiber<void, unknown> | null = null;

  constructor(deps: CaptureDeps) {
    this.deps = deps;
    this.win = deps.window ?? window;
    this.doc = deps.document ?? document;
    this.nav = deps.navigator ?? navigator;
    this.storage = deps.localStorage ?? localStorage;
    this.client = deps.client ?? makeListenersClient();
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.wakeLock = this.nav.wakeLock === undefined ? 'unsupported' : 'released';
    this.listener = Option.getOrNull(decodeStored(this.storage.getItem(LISTENER_KEY)));
    this.listen(this.win, 'pagehide', () => this.endPage());
    this.listen(this.doc, 'freeze', () => this.endPage());
    this.listen(this.doc, 'visibilitychange', () => this.onVisible());
    this.listen(this.win, 'online', () => this.startDrain());
    this.heartbeat = setInterval(() => void this.beat(), this.timing.heartbeatMs);
    this.ready = this.init();
    this.publish();
  }

  readonly start = async (): Promise<void> => {
    await this.ready;
    if (this.phase === 'starting' || this.phase === 'capturing') return;
    const unsupported = this.unsupported();
    if (unsupported !== null) {
      this.permission = 'unsupported';
      this.issue = unsupported;
      return this.publish();
    }
    const before = this.permission;
    Object.assign(this, { phase: 'starting', permission: 'pending', issue: null, cancelStart: null });
    this.publish();
    try {
      const session = await this.openSession();
      if (this.cancelStart !== null) {
        await session.recorder.close().catch(() => { });
        session.stream.getTracks().forEach((track) => track.stop());
        await session.releaseLock();
        Object.assign(this, { phase: this.cancelStart, permission: 'granted' });
        return this.publish();
      }
      this.session = session;
      Object.assign(this, { phase: 'capturing', permission: 'granted', claimed: true, interrupted: false, missing: false, muted: false });
      void this.requestWakeLock();
    } catch (error) {
      this.phase = 'stopped';
      this.issue = captureIssue(error);
      this.permission = this.issue === 'permission_denied' ? 'denied' : before;
    }
    this.publish();
  };

  readonly pause = async (): Promise<void> => {
    this.issue = null;
    await this.stopSession('pause', 'paused');
  };

  readonly resume = (): Promise<void> => this.start();

  dispose(): void {
    clearInterval(this.heartbeat);
    this.unlisten.forEach((remove) => remove());
    this.endPage();
    if (this.drain !== null) Effect.runFork(Fiber.interrupt(this.drain));
    void this.buffer?.then((buffer) => buffer.close(), () => { });
  }

  private unsupported(): CaptureIssue | null {
    if (!this.win.isSecureContext) return 'insecure_context';
    return this.nav.mediaDevices?.getUserMedia === undefined ? 'unsupported_constraints' : null;
  }

  private async init(): Promise<void> {
    this.permission = await watchMicrophonePermission(this.nav.permissions, (state) => this.onPermission(state));
    this.publish();
    const release = await holdCaptureLock(this.nav.locks).catch(() => null);
    if (release === null) return; // another tab is capturing; its parts are still being written
    try {
      const buffer = await this.openBuffer();
      if ((await buffer.recoverOrphans()) > 0) this.interrupted = true;
      ({ pending: this.pending, stranded: this.stranded } = await buffer.countChunks(this.listener?.id ?? null));
      this.savedThroughMs = await buffer.savedThroughMs();
      this.claimed = this.interrupted || this.pending > 0;
    } catch {
      // Storage problems surface as issues when capture starts.
    } finally {
      await release();
    }
    this.publish();
    this.startDrain();
  }

  private openBuffer(): Promise<CaptureBuffer> {
    this.buffer ??= (this.deps.openBuffer ?? RecoveryBuffer.open)().then(
      (buffer) => {
        buffer.onLost = () => this.onStorageLost();
        return buffer;
      },
      (error: unknown) => {
        this.buffer = null;
        throw error;
      },
    );
    return this.buffer;
  }

  private async openSession(): Promise<Session> {
    const releaseLock = await holdCaptureLock(this.nav.locks);
    let stream: MediaStream | null = null;
    try {
      const buffer = await this.openBuffer();
      const listener = await this.ensureListener(buffer);
      stream = await acquireMicrophone(this.nav.mediaDevices);
      const recorder = await (this.deps.startRecorder ?? startRecorder)(stream, (start, samples) => this.onBlock(start, samples));
      if (!isSampleRate(recorder.sampleRate)) {
        await recorder.close();
        throw new DOMException(`unsupported sample rate ${recorder.sampleRate}`, 'NotSupportedError');
      }
      this.watchTrack(stream);
      return { stream, recorder, buffer, listener, releaseLock, epoch: null, stopping: false };
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      await releaseLock();
      throw error;
    }
  }

  private async ensureListener(buffer: CaptureBuffer): Promise<StoredListener> {
    if (this.listener !== null) return this.listener;
    const capabilities = {
      audio_worklet: typeof AudioWorkletNode !== 'undefined',
      wake_lock: this.nav.wakeLock !== undefined,
      web_locks: this.nav.locks !== undefined,
      persistent_storage: await buffer.persist(),
    };
    const listener = await Effect.runPromise(this.client.registerListener({ payload: { name: 'Browser listener', mode: 'laptop', capabilities } }));
    this.saveListener({ id: listener.id, lease_generation: listener.lease_generation });
    return this.listener!;
  }

  private saveListener(listener: StoredListener | null): void {
    this.listener = listener;
    if (listener === null) this.storage.removeItem(LISTENER_KEY);
    else this.storage.setItem(LISTENER_KEY, JSON.stringify(listener));
  }

  private onBlock(sampleStart: number, samples: Int16Array): void {
    const session = this.session;
    if (session === null) return;
    const now = Date.now();
    const rate = session.recorder.sampleRate;
    let epoch = session.epoch;
    if (epoch !== null && now - epoch.lastWallMs - ((sampleStart + samples.length - epoch.lastEnd) / rate) * 1000 > this.timing.gapMs) {
      // The sample clock paused (sleep, suspension) while wall time moved: re-anchor in a new epoch.
      epoch.live?.stop('close');
      void epoch.assembler.close();
      epoch = null;
    }
    epoch ??= session.epoch = this.openEpoch(session, sampleStart, now - (samples.length / rate) * 1000);
    const offset = sampleStart - epoch.base;
    epoch.assembler.write(offset, samples);
    epoch.live?.send(offset, samples);
    epoch.lastWallMs = now;
    epoch.lastEnd = sampleStart + samples.length;
  }

  private openEpoch(session: Session, base: number, startedAtMs: number): Epoch {
    const sampleRate = session.recorder.sampleRate;
    const start = decodeStart({
      _tag: 'start',
      protocol_version: 1,
      listener_id: session.listener.id,
      epoch_id: crypto.randomUUID(),
      track: 0,
      clock: {
        sample_rate: sampleRate,
        channels: 1,
        encoding: 'pcm_s16le',
        sample_start: 0,
        captured_at: new Date(startedAtMs).toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      lease_generation: session.listener.lease_generation,
    });
    const assembler = new ChunkAssembler({ listenerId: start.listener_id, epochId: start.epoch_id, sampleRate, startedAtMs }, session.buffer, {
      chunkSamples: Math.round(sampleRate * this.timing.chunkSeconds),
      commitSamples: Math.round(sampleRate * this.timing.commitSeconds),
      onSealed: () => void this.refreshPending().then(() => this.startDrain()),
      onError: (error) => this.halt(captureIssue(error), false),
    });
    const url = (this.deps.streamUrl ?? streamUrl)(start.listener_id);
    const live = this.leaseLost ? null : (this.deps.openLive ?? openLiveStream)({ url, start, onStatus: (status, reason) => this.onLive(status, reason), ...(this.deps.onSpeech ? { onSpeech: this.deps.onSpeech } : {}) });
    queueMicrotask(() => this.publish());
    return { id: start.epoch_id, base, assembler, live, lastWallMs: startedAtMs, lastEnd: base };
  }

  private onLive(status: LiveStatus, reason?: RejectReason): void {
    this.live = status;
    if (status === 'rejected') this.issue = reason === 'stale_generation' ? 'lease_lost' : 'socket_unavailable';
    if (status === 'rejected' && reason === 'stale_generation') {
      this.leaseLost = true;
      if (this.session?.epoch) this.session.epoch.live = null;
    }
    this.publish();
  }

  private async stopSession(reason: StopReason, phase: 'paused' | 'stopped'): Promise<void> {
    const session = this.session;
    if (session === null && this.phase === 'starting') this.cancelStart = phase;
    if (session === null || session.stopping) return;
    session.stopping = true;
    session.epoch?.live?.stop(reason);
    await session.recorder.flush();
    this.session = null;
    await session.epoch?.assembler.close();
    await session.recorder.close().catch(() => { });
    session.stream.getTracks().forEach((track) => track.stop());
    await session.releaseLock();
    void this.sentinel?.release();
    this.phase = phase;
    this.live = null;
    await this.refreshPending();
    this.startDrain();
  }

  /** Stops capture for a reason the listener must see; `interrupted` marks the archive gap. */
  private halt(issue: CaptureIssue, interrupted: boolean): void {
    this.issue = issue;
    this.interrupted ||= interrupted;
    void this.stopSession('close', 'paused');
    this.publish();
  }

  /** Tab close, navigation or freeze: release the microphone now; recovery finishes the rest on next load. */
  private endPage(): void {
    this.session?.stream.getTracks().forEach((track) => track.stop());
    if (this.session !== null) this.halt('input_lost', true);
  }

  private watchTrack(stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => this.session?.stream === stream && this.halt('input_lost', true));
      track.addEventListener('mute', () => this.setMuted(stream, true));
      track.addEventListener('unmute', () => this.setMuted(stream, false));
    }
  }

  private setMuted(stream: MediaStream, muted: boolean): void {
    if (this.session?.stream !== stream) return;
    this.muted = muted;
    if (muted) this.issue = 'input_lost';
    else if (this.issue === 'input_lost') this.issue = null;
    this.publish();
  }

  private onPermission(state: PermissionState): void {
    this.permission = state;
    if (state === 'denied' && this.session !== null) this.halt('permission_denied', true);
    this.publish();
  }

  private onStorageLost(): void {
    this.missing = true;
    this.buffer = null;
    if (this.session !== null) this.halt('storage_unavailable', true);
    else this.issue = 'storage_unavailable';
    this.publish();
  }

  private onVisible(): void {
    const session = this.session;
    if (this.doc.visibilityState !== 'visible' || session === null) return;
    if (session.stream.getAudioTracks().every((track) => track.readyState === 'ended')) this.halt('input_lost', true);
    else void this.requestWakeLock();
  }

  private async requestWakeLock(): Promise<void> {
    const wakeLock = this.nav.wakeLock;
    if (wakeLock === undefined || this.sentinel !== null || this.doc.visibilityState !== 'visible') return;
    try {
      const sentinel = await wakeLock.request('screen');
      if (this.session === null) return void sentinel.release();
      this.sentinel = sentinel;
      this.wakeLock = 'held';
      sentinel.addEventListener('release', () => {
        this.sentinel = null;
        this.wakeLock = 'released';
        this.publish();
      });
    } catch {
      this.wakeLock = 'released';
    }
    this.publish();
  }

  private async beat(): Promise<void> {
    const listener = this.listener;
    if (listener === null) return;
    this.startDrain();
    const buffer = await this.buffer?.catch(() => null);
    const snapshot = this.getSnapshot();
    const payload = {
      lease_generation: listener.lease_generation,
      state: snapshot.listener,
      epoch_id: this.session?.epoch?.id ?? null,
      buffered_chunks: this.pending,
      storage_bytes_free: buffer?.freeBytes ?? null,
    };
    const exit = await Effect.runPromiseExit(this.client.heartbeat({ path: { listener_id: listener.id }, payload }));
    if (Exit.isSuccess(exit)) {
      this.saveListener({ ...listener, lease_generation: exit.value.lease_generation });
      if (this.session?.listener.id === listener.id) this.session.listener = this.listener!;
      this.onOwnership(exit.value.owner);
    } else if (Option.getOrNull(Cause.failureOption(exit.cause))?._tag === 'NotFound') {
      this.saveListener(null); // the server no longer knows this listener; the next start registers again
      void this.refreshPending(); // its chunks are now stranded: kept locally, no longer pending
    }
  }

  private onOwnership(owner: boolean): void {
    if (owner === !this.leaseLost) return;
    this.leaseLost = !owner;
    const epoch = this.session?.epoch;
    if (!owner && epoch) {
      epoch.live?.stop('close');
      epoch.live = null;
    }
    if (owner && epoch && epoch.live === null) {
      void epoch.assembler.close();
      this.session!.epoch = null;
      this.live = null;
    }
    if (!owner) this.issue = 'lease_lost';
    else if (this.issue === 'lease_lost') this.issue = null;
    this.publish();
  }

  private startDrain(): void {
    const listener = this.listener;
    if (this.drain !== null || listener === null || this.buffer === null) return;
    const events = {
      onUploading: () => {
        this.uploading = true;
        this.publish();
      },
      onSaved: (manifest: RecordingChunkManifest) => {
        const end = Date.parse(manifest.captured_at) + (manifest.sample_count / manifest.sample_rate) * 1000;
        this.savedThroughMs = Math.max(this.savedThroughMs ?? end, end);
        void this.refreshPending();
      },
      onConflict: () => void this.refreshPending(),
    };
    const fiber = Effect.runFork(
      Effect.promise(() => this.buffer!).pipe(Effect.flatMap((buffer) => drainPending(buffer, this.client, listener.id, events, this.deps.uploader))),
    );
    this.drain = fiber;
    fiber.addObserver(() => {
      this.drain = null;
      this.uploading = false;
      void this.refreshPending();
    });
  }

  private async refreshPending(): Promise<void> {
    const buffer = await this.buffer?.catch(() => null);
    const counts = await buffer?.countChunks(this.listener?.id ?? null).catch(() => null);
    if (counts) ({ pending: this.pending, stranded: this.stranded } = counts);
    this.publish();
  }

  private listenerState(): ListenerState {
    if (this.phase !== 'capturing') return this.phase;
    if (this.muted || this.leaseLost || this.live === 'degraded' || this.live === 'rejected') return 'degraded';
    if (this.live === 'reconnecting') return 'reconnecting';
    return this.live === 'live' ? 'listening' : 'starting';
  }

  private archiveState() {
    if (this.missing) return 'missing';
    if (this.interrupted) return 'interrupted';
    if (this.uploading) return 'uploading';
    if (this.pending > 0) return 'buffered_locally';
    if (this.phase === 'capturing') return 'capturing';
    return this.claimed && this.savedThroughMs !== null ? 'saved_remotely' : null;
  }

  private publish(): void {
    this.store.update({
      listener: this.listenerState(),
      permission: this.permission,
      archive: this.archiveState(),
      issue: this.issue,
      epochId: this.session?.epoch?.id ?? null,
      bufferedChunks: this.pending,
      strandedChunks: this.stranded,
      savedThroughMs: this.savedThroughMs,
      wakeLock: this.wakeLock,
    });
  }

  private listen(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, type: string, handler: () => void): void {
    target.addEventListener(type, handler);
    this.unlisten.push(() => target.removeEventListener(type, handler));
  }
}

export function createCaptureController(deps: CaptureDeps = {}): CaptureView & { dispose(): void } {
  return new CaptureController(deps);
}
