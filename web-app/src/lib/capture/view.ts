/** Listener lifecycle (plan 06). */
export type ListenerState = 'stopped' | 'starting' | 'listening' | 'reconnecting' | 'paused' | 'degraded';
export type PermissionState = 'unknown' | 'prompt' | 'pending' | 'granted' | 'denied' | 'unsupported';
/** Archive durability (plan 05). */
export type ArchiveState = 'capturing' | 'buffered_locally' | 'uploading' | 'saved_remotely' | 'interrupted' | 'missing';
export type CaptureIssue =
  | 'insecure_context'
  | 'permission_denied'
  | 'no_input'
  | 'input_lost'
  | 'hardware_error'
  | 'unsupported_constraints'
  | 'storage_full'
  | 'storage_unavailable'
  | 'socket_unavailable'
  | 'lease_lost';

export interface CaptureSnapshot {
  readonly listener: ListenerState;
  readonly permission: PermissionState;
  /** `null` until a capture has started; no archive claim is made before then. */
  readonly archive: ArchiveState | null;
  readonly issue: CaptureIssue | null;
  readonly epochId: string | null;
  readonly bufferedChunks: number;
  /** Chunks kept on this device that cannot be uploaded: their listener is gone or the server refused them. */
  readonly strandedChunks: number;
  readonly savedThroughMs: number | null;
  readonly wakeLock: 'unsupported' | 'released' | 'held';
}

export interface LevelSource {
  readonly bandCount: number;
  /** Fills `bands` (length bandCount) with 0..1 energy per band, returns overall 0..1 level. Must not allocate. */
  read(bands: Float32Array): number;
}

/** Samples missing inside a recording; `at` is the position in the exported file, which is not padded. */
export interface RecordingGap {
  readonly at: number;
  readonly missing: number;
}

/** One capture epoch of a listener the server forgot, kept on this device and never uploadable. */
export interface OrphanedRecording {
  readonly listenerId: string;
  readonly epochId: string;
  readonly sampleRate: number;
  /** Wall-clock time of the first kept sample, anchored to the epoch's sample clock. */
  readonly startedAt: string;
  /** Kept samples, i.e. the exported file's length. */
  readonly sampleCount: number;
  readonly chunkCount: number;
  readonly gaps: readonly RecordingGap[];
}

export interface CaptureView {
  getSnapshot(): CaptureSnapshot;
  subscribe(listener: () => void): () => void;
  readonly levels: LevelSource;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Recordings orphaned by a removed listener; never the pending or in-progress audio. */
  orphanedRecordings(): Promise<readonly OrphanedRecording[]>;
  /** One WAV built from the recording's chunks on this device; no server call. */
  exportRecording(recording: OrphanedRecording): Promise<Blob>;
  /** Deletes only this orphaned recording's chunks, and only when a person asks. */
  discardRecording(recording: OrphanedRecording): Promise<void>;
}

export const initialCaptureSnapshot: CaptureSnapshot = Object.freeze({
  listener: 'stopped',
  permission: 'unknown',
  archive: null,
  issue: null,
  epochId: null,
  bufferedChunks: 0,
  strandedChunks: 0,
  savedThroughMs: null,
  wakeLock: 'released',
});

function differs(snapshot: CaptureSnapshot, patch: Partial<CaptureSnapshot>): boolean {
  return (Object.keys(patch) as (keyof CaptureSnapshot)[]).some((key) => patch[key] !== snapshot[key]);
}

/** Frozen-snapshot store; notifies only when a field actually changes (useSyncExternalStore-safe). */
export function createCaptureStore(initial: CaptureSnapshot = initialCaptureSnapshot): {
  view: Pick<CaptureView, 'getSnapshot' | 'subscribe'>;
  update(patch: Partial<CaptureSnapshot>): void;
} {
  let snapshot: CaptureSnapshot = Object.freeze({ ...initial });
  const listeners = new Set<() => void>();
  return {
    view: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    update(patch) {
      if (!differs(snapshot, patch)) return;
      snapshot = Object.freeze({ ...snapshot, ...patch });
      for (const listener of listeners) listener();
    },
  };
}
