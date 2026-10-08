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
  | 'signed_out'
  | 'lease_lost'
  | 'listener_removed'
  | 'transcription_unavailable'
  | 'transcription_behind';

export interface CaptureSnapshot {
  readonly listener: ListenerState;
  readonly permission: PermissionState;
  /** `null` until a capture has started; no archive claim is made before then. */
  readonly archive: ArchiveState | null;
  readonly issue: CaptureIssue | null;
  readonly epochId: string | null;
  readonly bufferedChunks: number;
  /** Chunks of removed listeners (the server no longer knows them) kept on this device: never uploadable, listed for export or discard while no tab captures. */
  readonly strandedChunks: number;
  /** Chunks of this device's listeners that the server refused (e.g. recorded after another device took the lease) kept on this device. */
  readonly refusedChunks: number;
  readonly savedThroughMs: number | null;
  readonly wakeLock: 'unsupported' | 'released' | 'held';
}

export interface LevelSource {
  readonly bandCount: number;
  /** Fills `bands` (length bandCount) with 0..1 energy per band, returns overall 0..1 level. Must not allocate. */
  read(bands: Float32Array): number;
}

/** Samples missing inside one exported file; `at` is where they are missing on the recording's capture sample clock. */
export interface RecordingGap {
  readonly at: number;
  readonly missing: number;
}

/** One exported WAV file's range, `sampleStart`..`sampleEnd` on the recording's capture sample clock, and the gaps inside it. */
export interface RecordingPart {
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly gaps: readonly RecordingGap[];
}

/** One capture epoch of a listener the server forgot, kept on this device and never uploadable. */
export interface OrphanedRecording {
  readonly listenerId: string;
  readonly epochId: string;
  readonly sampleRate: number;
  /** Wall-clock time of the first kept sample, anchored to the epoch's sample clock. */
  readonly startedAt: string;
  /** Kept samples, i.e. the exported files' length. */
  readonly sampleCount: number;
  readonly chunkCount: number;
  /** The WAV files an export writes, in order; more than one only over the WAV size limit. */
  readonly parts: readonly RecordingPart[];
}

/** One exported WAV file, holding samples `sampleStart`..`sampleEnd` of the recording's capture sample clock. */
export interface WavPart {
  readonly blob: Blob;
  readonly sampleStart: number;
  readonly sampleEnd: number;
}

export interface CaptureView {
  getSnapshot(): CaptureSnapshot;
  subscribe(listener: () => void): () => void;
  readonly levels: LevelSource;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Recordings orphaned by a removed listener, never pending audio; null while any tab of this browser captures. */
  orphanedRecordings(): Promise<readonly OrphanedRecording[] | null>;
  /** One WAV file (`part` of `recording.parts`) of the recording's chunks on this device, or null once they are gone; no server call. */
  exportRecording(recording: OrphanedRecording, part: number): Promise<WavPart | null>;
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
  refusedChunks: 0,
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
