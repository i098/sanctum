/**
 * Live PCM path (plan 05 "Live path"): send the validated `start`, wait for `accepted`, then
 * stream binary frames. Live acceptance is never archive durability; frames dropped while
 * disconnected or over the `bufferedAmount` bound are recovered from uploaded chunks.
 */
import {
  encodePcmFrame,
  LISTENER_STREAM_PATH,
  type RejectedMessage,
  ServerControlMessage,
  type SpeechCancelMessage,
  type SpeechChunkMessage,
  StartMessage,
} from '@sanctum/contracts';
import { Either, Schema } from 'effect';

export type LiveStatus = 'connecting' | 'reconnecting' | 'live' | 'degraded' | 'rejected';
export type StopReason = 'pause' | 'close' | 'device_change';

/** About two seconds of 48 kHz PCM16 queued in the socket before live frames are dropped. */
const MAX_BUFFERED_BYTES = 192_000;
const RETRY_MS = 2_000;

export interface LiveOptions {
  readonly url: string;
  readonly start: StartMessage;
  /** `reason` accompanies `rejected`. */
  onStatus(status: LiveStatus, reason?: RejectReason): void;
  /** Requested speech for this socket (`speech_chunk`/`speech_cancel`); only the playback module acts on it. */
  onSpeech?(message: SpeechChunkMessage | SpeechCancelMessage): void;
  readonly WebSocket?: typeof WebSocket;
}

export interface LiveStream {
  /** Sends one block if the server accepted the stream and the socket is not backed up. */
  send(sampleStart: number, samples: Int16Array): void;
  /** A `null` reason drops the socket without a `stop`, so the server records the epoch as interrupted. */
  stop(reason: StopReason | null): void;
}

type StartMessage = typeof StartMessage.Type;
export type RejectReason = (typeof RejectedMessage.Type)['reason'];

const decodeServer = Schema.decodeUnknownEither(Schema.parseJson(ServerControlMessage));
const encodeStart = Schema.encodeSync(StartMessage);

export function streamUrl(listenerId: string, origin = globalThis.location.origin): string {
  return new URL(LISTENER_STREAM_PATH.replace(':listener_id', listenerId), origin.replace(/^http/, 'ws')).href;
}

/** Requested-speech messages go to playback; everything else is socket control. */
const speechMessage = (message: ServerControlMessage) =>
  message._tag === 'speech_chunk' || message._tag === 'speech_cancel' ? message : null;

const ignoreSpeech = () => {};

export function openLiveStream({ url, start, onStatus, onSpeech = ignoreSpeech, WebSocket: Socket = WebSocket }: LiveOptions): LiveStream {
  let socket: WebSocket | null = null;
  let accepted = false;
  let stopped = false;
  let sequence = 0;
  let backedUp = false;
  let serverDegraded = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const onControl = (ws: WebSocket, message: ServerControlMessage) => {
    if (message._tag === 'accepted') {
      accepted = true;
      onStatus(serverDegraded ? 'degraded' : 'live');
    } else if (message._tag === 'rejected') {
      stopped = true;
      ws.close(1000);
      onStatus('rejected', message.reason);
    } else if (message._tag === 'degraded') {
      serverDegraded = true;
      onStatus('degraded');
    }
  };

  const onMessage = (ws: WebSocket, data: unknown) => {
    const decoded = decodeServer(data);
    if (Either.isLeft(decoded)) return;
    const speech = speechMessage(decoded.right);
    if (speech) onSpeech(speech);
    else onControl(ws, decoded.right);
  };

  const connect = () => {
    const ws = new Socket(url);
    socket = ws;
    accepted = false;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify(encodeStart(start)));
    ws.onmessage = ({ data }) => onMessage(ws, data);
    ws.onclose = () => {
      if (socket !== ws || stopped) return;
      socket = null;
      retry = setTimeout(connect, RETRY_MS);
      onStatus('reconnecting');
    };
  };

  onStatus('connecting');
  connect();
  return {
    send(sampleStart, samples) {
      if (socket === null || !accepted) return;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        if (!backedUp) onStatus('degraded');
        backedUp = true;
        return;
      }
      if (backedUp && !serverDegraded) onStatus('live');
      backedUp = false;
      socket.send(encodePcmFrame({ track: start.track, sequence: sequence++, sample_start: sampleStart, sample_count: samples.length }, samples) as Uint8Array<ArrayBuffer>);
    },
    stop(reason) {
      stopped = true;
      clearTimeout(retry);
      if (reason !== null && socket?.readyState === Socket.OPEN) socket.send(JSON.stringify({ _tag: 'stop', reason }));
      socket?.close(1000);
      socket = null;
    },
  };
}
