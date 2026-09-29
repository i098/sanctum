/**
 * The page's single capture engine. It lives above every overlay and router lifecycle, so
 * opening or closing Review, Agents or Settings never recreates the microphone stream.
 * Requested speech plays through one lazily created AudioContext; nothing plays unless the
 * server sends `speech_chunk` for a direct request.
 */
import { createCaptureController } from '../../lib/capture/controller.ts';
import { createPlayback } from '../../lib/capture/playback.ts';
import type { CaptureView } from '../../lib/capture/view.ts';

let engine: CaptureView | null = null;
let playback: ReturnType<typeof createPlayback> | null = null;

export function getCaptureEngine(): CaptureView {
  if (engine === null) {
    const created = createCaptureController({ onSpeech: message => (playback ??= createPlayback(new AudioContext())).handle(message) });
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
