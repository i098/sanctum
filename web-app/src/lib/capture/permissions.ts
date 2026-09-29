/**
 * Microphone permission and device outcomes (plan 05 "Live path"): pending, denied, missing
 * input, hardware errors and unsupported constraints stay distinct, and a revoked permission is
 * observed through the Permissions API where the browser offers it.
 */
import { StorageError } from './recorder.ts';
import type { CaptureIssue, PermissionState } from './view.ts';

/** Another tab of this browser holds the capture lock. */
class CaptureLockHeld extends Error { }

/** Raw mono speech: browser echo cancellation on, no gain or noise processing on the archive. */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
};

const DEVICE_ISSUES: Record<string, CaptureIssue> = {
  NotAllowedError: 'permission_denied',
  SecurityError: 'permission_denied',
  NotFoundError: 'no_input',
  OverconstrainedError: 'unsupported_constraints',
  NotSupportedError: 'unsupported_constraints',
  NotReadableError: 'hardware_error',
  AbortError: 'hardware_error',
};

export function captureIssue(error: unknown): CaptureIssue {
  if (error instanceof StorageError) return error.kind === 'full' ? 'storage_full' : 'storage_unavailable';
  if (error instanceof CaptureLockHeld) return 'lease_lost';
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  return DEVICE_ISSUES[name] ?? 'socket_unavailable';
}

/** Prompts if needed; a stream without a live audio track counts as missing input. */
export async function acquireMicrophone(mediaDevices: MediaDevices): Promise<MediaStream> {
  const stream = await mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
  if (stream.getAudioTracks().some((track) => track.readyState === 'live')) return stream;
  stream.getTracks().forEach((track) => track.stop());
  throw new DOMException('no live microphone track', 'NotFoundError');
}

/** Current microphone permission, reporting later changes (revocation) to `onChange`. */
export async function watchMicrophonePermission(
  permissions: Permissions | undefined,
  onChange: (state: PermissionState) => void,
): Promise<PermissionState> {
  try {
    const status = await permissions!.query({ name: 'microphone' as PermissionName });
    status.addEventListener('change', () => onChange(status.state));
    return status.state;
  } catch {
    return 'unknown';
  }
}

/**
 * Holds the browser-wide capture lock until the returned release is called, so two tabs of one
 * browser cannot record the same room; resolves without locking where Web Locks are missing.
 * The release resolves once the lock is actually free again.
 */
export async function holdCaptureLock(locks: LockManager | undefined): Promise<() => Promise<void>> {
  if (locks === undefined) return async () => {};
  let unlock = () => {};
  const held = new Promise<void>((resolve) => (unlock = resolve));
  let freed: Promise<unknown> | undefined;
  const granted = await new Promise<boolean>((resolve) => {
    freed = locks.request('sanctum-capture', { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      return lock === null ? undefined : held;
    });
  });
  if (!granted) throw new CaptureLockHeld('capture is active in another tab');
  return async () => {
    unlock();
    await freed;
  };
}
