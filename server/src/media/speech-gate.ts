/**
 * Request-scoped speech gate (plan section 04, "Live media and speech ownership"). Sanctum is
 * silent unless a person directly addresses it: a completed direct-request turn opens one
 * window with a fresh generation, and every audio chunk is checked against that window
 * immediately before it is sent. Barge-in, pause, disconnect, expiry or a newer request close
 * the window; late chunks of an old generation are dropped here and again in the browser.
 * Media's session.ts drives `speechController` per socket; nothing else can emit speech.
 */
import type { AccessScope, CaptureEpochId, ListenerId, SpeechCancelMessage, SpeechCancelReason, SpeechChunkMessage, TranscriptSegment, Unavailable } from '@sanctum/contracts';
import { Context, Effect, Fiber, Stream } from 'effect';
import { engineeringDefaults } from '../config.ts';
import { SPEECH_SAMPLE_RATE, SpeechSynthesizer } from '../providers/speech.ts';

export interface SpeechWindow {
  readonly listener_id: ListenerId;
  readonly epoch_id: CaptureEpochId;
  readonly request_id: string;
  readonly generation: number;
  /** Source sample where the request turn ended. */
  readonly sample_end: number;
  readonly expires_at: number;
}

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** Heard text that is mostly words Sanctum itself just played is echo, not a person. */
const ECHO_OVERLAP = 0.6;

export const makeSpeechGate = (now: () => number = Date.now) => {
  const { windowMs, echoTailMs } = engineeringDefaults.speech;
  const open = new Map<ListenerId, SpeechWindow>();
  /** Words of the listener's current or last reply, heard as echo until `until`. */
  const played = new Map<ListenerId, { words: Set<string>; until: number }>();
  let generation = 0;
  return {
    now,
    openRequest: (input: { listener_id: ListenerId; epoch_id: CaptureEpochId; request_id: string; sample_end: number }): SpeechWindow => {
      // Time-based floor keeps generations rising across API restarts, so browsers reject stale audio.
      generation = Math.max(generation + 1, now());
      const window = { ...input, generation, expires_at: now() + windowMs };
      open.set(input.listener_id, window);
      return window;
    },
    mayEmit: (request_id: string, generation: number) =>
      [...open.values()].some(window => window.request_id === request_id && window.generation === generation && window.expires_at > now()),
    /** Closes the listener's window; the returned message tells the browser to drop that generation. */
    cancel: (listener_id: ListenerId, reason: SpeechCancelReason): SpeechCancelMessage | null => {
      const window = open.get(listener_id);
      if (!window) return null;
      open.delete(listener_id);
      return { _tag: 'speech_cancel', generation: window.generation, reason };
    },
    active: (listener_id: ListenerId) => open.get(listener_id),
    notePlayed: (listener_id: ListenerId, text: string, until: number) => {
      const recent = played.get(listener_id);
      const known = recent && recent.until > now() ? recent.words : new Set<string>();
      for (const word of words(text)) known.add(word);
      played.set(listener_id, { words: known, until: until + echoTailMs });
    },
    isEcho: (listener_id: ListenerId, text: string) => {
      const heard = words(text);
      const recent = played.get(listener_id);
      if (!recent || recent.until <= now() || heard.length === 0) return false;
      return heard.filter(word => recent.words.has(word)).length / heard.length >= ECHO_OVERLAP;
    },
  };
};

/** One gate per API process by default: a listener's live socket always lands in the process that owns it. */
export class SpeechGate extends Context.Reference<SpeechGate>()('sanctum/SpeechGate', { defaultValue: () => makeSpeechGate() }) {}

/** "Sanctum, …" / "Hey Sanctum …" at the start of a turn; the rest is the request. */
/** Reply text for one direct request on one listener; provided by the API entrypoint (speech-requests.ts). */
export class SpeechReplies extends Context.Tag('sanctum/SpeechReplies')<
  SpeechReplies,
  (access: AccessScope, listener_id: ListenerId) => (request: string) => Stream.Stream<string, Unavailable>
>() {}

/** Work detection runs independently of requested speech and never emits audio. */
export class SpeechWorkRequests extends Context.Tag('sanctum/SpeechWorkRequests')<
  SpeechWorkRequests,
  (access: AccessScope, listener_id: ListenerId) => (request: string, window: SpeechWindow) => Effect.Effect<void>
>() {}

export const directRequest = (text: string) => /^\W*(?:(?:hey|hi|ok|okay)\W+)?sanctum\b\W*(.*)$/isu.exec(text.trim())?.[1]?.trim() || null;

/** Splits a streamed reply into sentences so speech starts before the whole reply exists. */
const sentences = <E>(text: Stream.Stream<string, E>) =>
  Stream.suspend(() => {
    let pending = '';
    return text.pipe(
      Stream.mapConcat(piece => {
        const parts = (pending + piece).split(/(?<=[.!?])\s+/);
        pending = parts.pop() ?? '';
        return parts.filter(part => part.trim() !== '');
      }),
      Stream.concat(Stream.suspend(() => Stream.fromIterable(pending.trim() === '' ? [] : [pending.trim()]))),
    );
  });

/**
 * What one heard segment means: empty text, Sanctum's own echo and a late transcript of the
 * request that opened the window are ignored; anything else a person says over an open
 * response interrupts it.
 */
const segmentRole = (gate: ReturnType<typeof makeSpeechGate>, listener_id: ListenerId, segment: TranscriptSegment) => {
  if (segment.text.trim() === '' || gate.isEcho(listener_id, segment.text)) return 'ignore';
  const active = gate.active(listener_id);
  if (!active) return 'listen';
  const partOfRequest = active.epoch_id === segment.source.epoch_id && segment.source.sample_start < active.sample_end;
  return partOfRequest ? 'ignore' : 'interrupt';
};

type SpeechMessage = SpeechChunkMessage | SpeechCancelMessage;

/**
 * Streams one requested reply as audio. Every sentence and every audio chunk re-checks the
 * window, so cancellation stops output at the next chunk even if the provider keeps sending.
 */
const speak = (
  io: {
    readonly gate: ReturnType<typeof makeSpeechGate>;
    readonly synthesizer: Context.Tag.Service<SpeechSynthesizer>;
    readonly listener_id: ListenerId;
    readonly send: (message: SpeechMessage) => Effect.Effect<void>;
    readonly reply: Stream.Stream<string, Unavailable>;
  },
  window: SpeechWindow,
) =>
  Effect.gen(function* () {
    const { gate, listener_id } = io;
    const live = () => gate.mayEmit(window.request_id, window.generation);
    let sequence = 0;
    let playedUntil = gate.now();
    yield* sentences(io.reply).pipe(
      Stream.takeWhile(live),
      Stream.runForEach(sentence =>
        io.synthesizer.synthesize(sentence).pipe(
          Stream.takeWhile(live),
          Stream.runForEach(audio => {
            playedUntil = Math.max(playedUntil, gate.now()) + (audio.byteLength / 2 / SPEECH_SAMPLE_RATE) * 1000;
            gate.notePlayed(listener_id, sentence, playedUntil);
            return io.send({ _tag: 'speech_chunk', request_id: window.request_id, generation: window.generation, sequence: sequence++,
              sample_rate: SPEECH_SAMPLE_RATE, audio: Buffer.from(audio).toString('base64') });
          }),
        ),
      ),
    );
    // A cancel from the controller would interrupt this very fiber before sending, so close the window here.
    if (gate.active(listener_id)?.generation !== window.generation) return;
    const expired = !live();
    const message = gate.cancel(listener_id, 'expired');
    if (expired && message) yield* io.send(message);
  }).pipe(Effect.catchAll(error => Effect.logWarning('Requested speech failed', error.message)));

const startsSeparateTurn = (
  turn: Pick<TranscriptSegment['source'], 'epoch_id' | 'sample_start' | 'sample_end'>,
  source: TranscriptSegment['source'],
  minimumGap: number,
) => turn.epoch_id !== source.epoch_id || source.sample_start - turn.sample_end >= minimumGap
  || turn.sample_start - source.sample_end >= minimumGap;

/**
 * Per-socket speech ownership for media's session: feed every transcript segment and the
 * socket's end. `respond` streams the reply text for one direct request (voice role).
 */
export const speechController = (options: {
  readonly listener_id: ListenerId;
  readonly sample_rate: number;
  readonly send: (message: SpeechMessage) => Effect.Effect<void>;
  readonly respond: (request: string) => Stream.Stream<string, Unavailable>;
  readonly requestWork?: (request: string, window: SpeechWindow) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const gate = yield* SpeechGate;
    const synthesizer = yield* SpeechSynthesizer;
    const { listener_id, send, requestWork = () => Effect.void } = options;
    const endOfTurnSamples = (engineeringDefaults.speech.endOfTurnMs * options.sample_rate) / 1000;
    let turn: { epoch_id: CaptureEpochId; segments: TranscriptSegment[]; sample_start: number; sample_end: number } | null = null;
    const seenFinals = new Set<TranscriptSegment['id']>();
    let turnTimer: Fiber.RuntimeFiber<void> | null = null;
    let speaking: Fiber.RuntimeFiber<void> | null = null;

    const cancel = (reason: SpeechCancelReason) =>
      Effect.gen(function* () {
        const message = gate.cancel(listener_id, reason);
        if (speaking) yield* Fiber.interrupt(speaking);
        if (message) yield* send(message);
      });

    const completeTurn = Effect.gen(function* () {
      const finished = turn;
      turn = null;
      if (!finished) return;
      finished.segments.sort((a, b) => a.source.sample_start - b.source.sample_start);
      const request = directRequest(finished.segments.map(segment => segment.text).join(' '));
      if (request === null) return;
      const window = gate.openRequest({ listener_id, epoch_id: finished.epoch_id, request_id: finished.segments[0]!.id, sample_end: finished.sample_end });
      speaking = yield* Effect.forkDaemon(speak({ gate, synthesizer, listener_id, send, reply: options.respond(request) }, window));
      yield* Effect.forkDaemon(requestWork(request, window));
    });

    /** Extends the open turn, or completes it first when this segment starts after a pause or in a new epoch. */
    const extendTurn = (segment: TranscriptSegment) =>
      Effect.gen(function* () {
        const { epoch_id, sample_start, sample_end } = segment.source;
        if (turn && startsSeparateTurn(turn, segment.source, endOfTurnSamples)) yield* completeTurn;
        if (turn) {
          turn.segments.push(segment);
          turn.sample_start = Math.min(turn.sample_start, sample_start);
          turn.sample_end = Math.max(turn.sample_end, sample_end);
        } else {
          turn = { epoch_id, segments: [segment], sample_start, sample_end };
        }
        if (turnTimer) yield* Fiber.interrupt(turnTimer);
        turnTimer = yield* Effect.forkDaemon(Effect.delay(completeTurn, engineeringDefaults.speech.turnWaitMs));
      });

    return {
      onSegment: (segment: TranscriptSegment) =>
        Effect.gen(function* () {
          if (segment.status === 'final') {
            if (seenFinals.has(segment.id)) return;
            seenFinals.add(segment.id);
          }
          const role = segmentRole(gate, listener_id, segment);
          if (role === 'ignore') return;
          if (role === 'interrupt') yield* cancel('barge_in');
          if (segment.status === 'final') yield* extendTurn(segment);
        }),
      /** Pause or disconnect: stop speech now; a reconnect never resumes it. */
      onEnd: (reason: 'pause' | 'disconnect') =>
        Effect.gen(function* () {
          if (turnTimer) yield* Fiber.interrupt(turnTimer);
          turn = null;
          yield* cancel(reason);
        }),
    };
  });
