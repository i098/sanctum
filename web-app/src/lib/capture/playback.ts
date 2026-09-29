/**
 * Browser playback of requested speech only (plan section 04). It plays nothing on its own:
 * audio starts only from `speech_chunk` messages, and a chunk plays only while its generation
 * is the newest one not cancelled. Cancel, pause, disconnect or a newer generation stop
 * current audio and drop every queued or late chunk of older generations, so a reconnect
 * never resumes an old reply. Recording playback is a separate, explicit user control.
 */
import type { SpeechCancelMessage, SpeechChunkMessage } from '@sanctum/contracts';

type Context = Pick<AudioContext, 'currentTime' | 'destination' | 'createBuffer' | 'createBufferSource'>;

export function createPlayback(context: Context) {
  let current = 0;
  /** Every generation at or below this is cancelled for good. */
  let cancelledThrough = 0;
  let playUntil = 0;
  const sources = new Set<AudioBufferSourceNode>();

  const stopAll = () => {
    for (const source of sources) source.stop();
    sources.clear();
    playUntil = 0;
  };

  const play = (chunk: SpeechChunkMessage) => {
    const bytes = Uint8Array.from(atob(chunk.audio), char => char.charCodeAt(0));
    const pcm = new DataView(bytes.buffer);
    const samples = new Float32Array(bytes.byteLength >> 1);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.getInt16(i * 2, true) / 32_768;
    if (samples.length === 0) return;
    const buffer = context.createBuffer(1, samples.length, chunk.sample_rate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => sources.delete(source);
    const at = Math.max(context.currentTime, playUntil);
    source.start(at);
    playUntil = at + buffer.duration;
    sources.add(source);
  };

  return {
    handle(message: SpeechChunkMessage | SpeechCancelMessage) {
      if (message._tag === 'speech_cancel') {
        cancelledThrough = Math.max(cancelledThrough, message.generation);
        if (current <= cancelledThrough) stopAll();
        return;
      }
      if (message.generation <= cancelledThrough || message.generation < current) return;
      if (message.generation > current) {
        stopAll();
        current = message.generation;
      }
      play(message);
    },
    /** Local pause or socket loss: stop now and reject anything late from what was playing. */
    stop() {
      cancelledThrough = Math.max(cancelledThrough, current);
      stopAll();
    },
    get playing() {
      return sources.size > 0;
    },
  };
}
