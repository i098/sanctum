/**
 * Opening one input and naming its failures, light enough for the page to import without the
 * recorder: Settings checks an input with it while capture is not running.
 */
import type { CaptureIssue } from './view.ts';

/**
 * Raw mono speech: browser echo cancellation on, no gain or noise processing on the archive.
 * Whisper reads the same PCM: on a speech + room-noise test, Chrome's noise suppression and gain
 * control changed "Sanctum, add a" to "Sanctum had a" at 5 dB SNR, and gain control would shift
 * the levels the server's speech gate is set for. The waveform removes steady noise on its own.
 */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
};

/** PCM16 peak at or below which audio is dead: about -90 dBFS, under any real room's noise floor, so a quiet room never counts. */
export const SILENT_PEAK = 1;
/** Seconds of dead audio before an input counts as sending no sound (a closed MacBook's built-in microphone). */
export const SILENT_SECONDS = 3;

/** Length of the dead run after `amount` more audio (samples, ms: the caller's unit) whose loudest sample was `peak` on the PCM16 scale: any sound ends the run. */
export const deadRun = (run: number, peak: number, amount: number): number => (peak > SILENT_PEAK ? 0 : run + amount);

const DEVICE_ISSUES: Record<string, CaptureIssue> = {
  NotAllowedError: 'permission_denied',
  SecurityError: 'permission_denied',
  NotFoundError: 'no_input',
  OverconstrainedError: 'unsupported_constraints',
  NotSupportedError: 'unsupported_constraints',
  NotReadableError: 'hardware_error',
  AbortError: 'hardware_error',
  /** `Effect.runPromise` rejects with a fiber failure named after the API error; a missing session is `Unauthenticated`. */
  '(FiberFailure) Unauthenticated': 'signed_out',
};

/** The issue an error names; an unnamed one counts as a failed server connection. */
export function deviceIssue(error: unknown): CaptureIssue {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  return DEVICE_ISSUES[name] ?? 'socket_unavailable';
}

/** Prompts if needed; a stream without a live audio track counts as missing input. `deviceId` null opens the default input. */
export async function acquireMicrophone(mediaDevices: MediaDevices, deviceId: string | null = null): Promise<MediaStream> {
  const audio = deviceId === null ? AUDIO_CONSTRAINTS : { ...AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } };
  const stream = await mediaDevices.getUserMedia({ audio });
  if (stream.getAudioTracks().some((track) => track.readyState === 'live')) return stream;
  stream.getTracks().forEach((track) => track.stop());
  throw new DOMException('no live microphone track', 'NotFoundError');
}
