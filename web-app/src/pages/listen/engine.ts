/**
 * The page's single capture engine. It lives above every overlay and router lifecycle, so
 * opening or closing Review, Agents or Settings never recreates the microphone stream.
 * Requested speech plays through one lazily created AudioContext; nothing plays unless the
 * server sends `speech_chunk` for a direct request. Live transcript segments fan out to the
 * page's transcript rail and action updates to its agent-work feed.
 */
import type { ActionUpdateMessage, TranscriptSegment } from '@sanctum/contracts';
import { createCaptureController } from '../../lib/capture/controller.ts';
import { createPlayback } from '../../lib/capture/playback.ts';
import type { CaptureView } from '../../lib/capture/view.ts';

let engine: CaptureView | null = null;
let playback: ReturnType<typeof createPlayback> | null = null;
const transcriptListeners = new Set<(segment: TranscriptSegment) => void>();
const actionListeners = new Set<(message: ActionUpdateMessage) => void>();

/** Receives every live transcript segment of the current capture until the returned cleanup runs. */
export function subscribeTranscript(listener: (segment: TranscriptSegment) => void): () => void {
  transcriptListeners.add(listener);
  return () => transcriptListeners.delete(listener);
}

/** Receives every agent-work feed update of the live socket until the returned cleanup runs. */
export function subscribeActions(listener: (message: ActionUpdateMessage) => void): () => void {
  actionListeners.add(listener);
  return () => actionListeners.delete(listener);
}

export function getCaptureEngine(): CaptureView {
  if (engine === null) {
    const created = createCaptureController({
      onSpeech: message => (playback ??= createPlayback(new AudioContext())).handle(message),
      onTranscript: segment => transcriptListeners.forEach(listener => listener(segment)),
      onActions: message => actionListeners.forEach(listener => listener(message)),
    });
    // Pause, reconnect or any stop ends local playback at once; a reconnect never resumes a reply.
    // 'degraded' (muted track, server-reported degradation, lost lease) does not cut a requested
    // reply: barge-in and newer generations still cancel it inside playback.
    created.subscribe(() => {
      const { listener } = created.getSnapshot();
      if (listener !== 'listening' && listener !== 'degraded') playback?.stop();
    });
    engine = created;
  }
  return engine;
}
