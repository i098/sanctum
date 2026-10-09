/**
 * Live PCM path (plan 05 "Live path"): send the validated `start`, wait for `accepted`, then
 * stream binary frames. Live acceptance is never archive durability; frames dropped while
 * disconnected or over the `bufferedAmount` bound are recovered from uploaded chunks.
 */
import {
  type ActionUpdateMessage,
  type DegradedMessage,
  encodePcmFrame,
  LISTENER_STREAM_PATH,
  type RejectedMessage,
  ServerControlMessage,
  type SpeechCancelMessage,
  type SpeechChunkMessage,
  StartMessage,
  type TranscriptSegment,
} from '@sanctum/contracts';
import { Either, Schema } from 'effect';

export type LiveStatus = 'connecting' | 'reconnecting' | 'live' | 'degraded' | 'rejected';
export type DegradedReason = (typeof DegradedMessage.Type)['reason'];
/** A status with its server reason: always for `rejected`, for `degraded` when the server reported it (`null`: local backpressure only). */
export type LiveUpdate = [status: 'rejected', reason: RejectReason] | [status: 'degraded', reason?: DegradedReason | null] | [status: 'connecting' | 'reconnecting' | 'live'];
export type StopReason = 'pause' | 'close' | 'device_change' | 'interrupted';

/** About two seconds of 48 kHz PCM16 queued in the socket before live frames are dropped. */
const MAX_BUFFERED_BYTES = 192_000;
const RETRY_MS = 2_000;

export interface LiveOptions {
  readonly url: string;
  readonly start: StartMessage;
  onStatus(...update: LiveUpdate): void;
  /** Requested speech for this socket (`speech_chunk`/`speech_cancel`); only the playback module acts on it. */
  onSpeech?(message: SpeechChunkMessage | SpeechCancelMessage): void;
  /** Live transcript segments for display; partial ones are never committed facts. */
  onTranscript?(segment: TranscriptSegment): void;
  /** Agent-work feed rows of the listener's open meeting: a snapshot after each (re)connect, then changes. */
  onActions?(message: ActionUpdateMessage): void;
  readonly WebSocket?: typeof WebSocket;
}

export interface LiveStream {
  /** Sends one block if the server accepted the stream and the socket is not backed up. */
  send(sampleStart: number, samples: Int16Array): void;
  stop(reason: StopReason): void;
}

type StartMessage = typeof StartMessage.Type;
export type RejectReason = (typeof RejectedMessage.Type)['reason'];

const decodeServer = Schema.decodeUnknownEither(Schema.parseJson(ServerControlMessage));
const encodeStart = Schema.encodeSync(StartMessage);

export function streamUrl(listenerId: string, origin = globalThis.location.origin): string {
  return new URL(LISTENER_STREAM_PATH.replace(':listener_id', listenerId), origin.replace(/^http/, 'ws')).href;
}

const ignore = () => {};

/** Requested speech goes to playback, transcript segments and action updates to display; false for socket control messages. */
function deliver(message: ServerControlMessage, { onSpeech = ignore, onTranscript = ignore, onActions = ignore }: Pick<LiveOptions, 'onSpeech' | 'onTranscript' | 'onActions'>): boolean {
  if (message._tag === 'transcript') onTranscript(message.segment);
  else if (message._tag === 'speech_chunk' || message._tag === 'speech_cancel') onSpeech(message);
  else if (message._tag === 'action_update') onActions(message);
  else return false;
  return true;
}

/** An update for no meeting: the feed collapses every row. Sent when the stream ends for good. */
const NO_FEED: ActionUpdateMessage = { _tag: 'action_update', meeting_id: null, actions: [] };

/** The server message in a frame, or null when it is malformed or the stream already stopped (a late frame must not refill the feed). */
const decodeOpen = (data: unknown, stopped: boolean): ServerControlMessage | null => (stopped ? null : Either.getOrNull(decodeServer(data)));

/** The status of an accepted stream: degraded with the last reason the server sent or while frames back up, else live. */
const resumed = (reason: DegradedReason | null, backedUp = false): LiveUpdate => (reason === null && !backedUp ? ['live'] : ['degraded', reason]);

/** The live-ASR trouble a frame reports: its reason for `degraded`, null for `recovered`, undefined for any other frame. */
const asrTrouble = (message: ServerControlMessage): DegradedReason | null | undefined => (message._tag === 'degraded' ? message.reason : message._tag === 'recovered' ? null : undefined);

export function openLiveStream({ url, start, onStatus, WebSocket: Socket = WebSocket, ...listeners }: LiveOptions): LiveStream {
  let socket: WebSocket | null = null;
  let accepted = false;
  let stopped = false;
  let sequence = 0;
  let backedUp = false;
  let serverDegraded: DegradedReason | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;

  /** The stream is gone for good: the feed collapses until the next connect's snapshot. */
  const clearFeed = () => deliver(NO_FEED, listeners);
  const onControl = (ws: WebSocket, message: ServerControlMessage) => {
    if (message._tag === 'accepted') {
      accepted = true;
      onStatus(...resumed(serverDegraded));
    } else if (message._tag === 'rejected') {
      stopped = true;
      clearFeed();
      ws.close(1000);
      onStatus('rejected', message.reason);
    } else {
      const trouble = asrTrouble(message);
      if (trouble === undefined) return;
      serverDegraded = trouble;
      onStatus(...resumed(trouble, backedUp));
    }
  };

  const onMessage = (ws: WebSocket, data: unknown) => {
    const message = decodeOpen(data, stopped);
    if (message !== null && !deliver(message, listeners)) onControl(ws, message);
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
        if (!backedUp) onStatus('degraded', serverDegraded);
        backedUp = true;
        return;
      }
      if (backedUp && serverDegraded === null) onStatus('live');
      backedUp = false;
      socket.send(encodePcmFrame({ track: start.track, sequence: sequence++, sample_start: sampleStart, sample_count: samples.length }, samples) as Uint8Array<ArrayBuffer>);
    },
    stop(reason) {
      stopped = true;
      clearTimeout(retry);
      if (socket?.readyState === Socket.OPEN) socket.send(JSON.stringify({ _tag: 'stop', reason }));
      socket?.close(1000);
      socket = null;
      clearFeed();
    },
  };
}
