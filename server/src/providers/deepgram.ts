/**
 * Deepgram speech-to-text adapters (plan section 09): live streaming over WebSocket and
 * prerecorded batch over HTTPS, both sending raw mono PCM16 (`encoding=linear16`).
 * Times in results are seconds from the first sample sent on that connection or request;
 * callers map them to epoch samples through the anchor they persisted (provider_connections).
 * Protocol per developers.deepgram.com (checked 2026-09): `token` subprotocol auth, JSON
 * `Results` messages, `KeepAlive` within 10 s of silence, `CloseStream` to flush finals.
 */
import { Config, Context, Effect, Exit, Layer, Mailbox, Option, Redacted, Schedule, Schema, type Scope, type Stream } from 'effect';
import { Unavailable } from '@sanctum/contracts';

export interface AsrResult {
  readonly start_s: number;
  readonly end_s: number;
  readonly is_final: boolean;
  readonly text: string;
  readonly confidence: number | null;
  /** Provider-local label; never an identity across connections. */
  readonly speaker: string | null;
}

export interface AsrStream {
  /** Queues audio without waiting; `false` once the connection is gone. */
  readonly send: (samples: Int16Array) => boolean;
  /** Bytes queued by `send` but not yet written to the network. */
  readonly backlogBytes: () => number;
  /** Results in arrival order; ends after `finish` once the provider flushed, fails on an unexpected close. */
  readonly results: Stream.Stream<AsrResult, Unavailable>;
  /** Asks the provider to flush final results and close the connection. */
  readonly finish: Effect.Effect<void>;
}

export class SpeechToText extends Context.Tag('sanctum/SpeechToText')<
  SpeechToText,
  {
    readonly provider: string;
    readonly model: string;
    readonly openStream: (sample_rate: number) => Effect.Effect<AsrStream, Unavailable, Scope.Scope>;
    readonly transcribe: (sample_rate: number, samples: Int16Array) => Effect.Effect<ReadonlyArray<AsrResult>, Unavailable>;
  }
>() {}

const Alternative = Schema.Struct({
  transcript: Schema.String,
  confidence: Schema.Number,
  words: Schema.optional(Schema.Array(Schema.Struct({ speaker: Schema.optional(Schema.Number) }))),
});
const LiveResults = Schema.Struct({
  type: Schema.Literal('Results'),
  start: Schema.Number,
  duration: Schema.Number,
  is_final: Schema.Boolean,
  channel: Schema.Struct({ alternatives: Schema.NonEmptyArray(Alternative) }),
});
const decodeLive = Schema.decodeUnknownOption(Schema.parseJson(LiveResults));

const BatchResponse = Schema.Struct({
  results: Schema.Struct({
    utterances: Schema.Array(
      Schema.Struct({ start: Schema.Number, end: Schema.Number, transcript: Schema.String, confidence: Schema.Number, speaker: Schema.optional(Schema.Number) }),
    ),
  }),
});

const label = (speaker: number | undefined) => (speaker === undefined ? null : String(speaker));

/** One `Results` message as an `AsrResult`; other message types (Metadata, SpeechStarted) yield none. */
export function parseLiveMessage(data: string): AsrResult | null {
  const decoded = decodeLive(data);
  if (Option.isNone(decoded)) return null;
  const { start, duration, is_final, channel } = decoded.value;
  const [best] = channel.alternatives;
  return { start_s: start, end_s: start + duration, is_final, text: best.transcript, confidence: best.confidence, speaker: label(best.words?.[0]?.speaker) };
}

const deepgramConfig = Config.all({
  apiKey: Config.option(Config.redacted('DEEPGRAM_API_KEY')),
  model: Config.string('DEEPGRAM_MODEL').pipe(Config.withDefault('nova-3')),
  baseUrl: Config.url('DEEPGRAM_URL').pipe(Config.withDefault(new URL('https://api.deepgram.com'))),
  batchTimeoutMs: Config.integer('DEEPGRAM_BATCH_TIMEOUT_MS').pipe(Config.withDefault(120_000)),
});
type DeepgramConfig = Config.Config.Success<typeof deepgramConfig>;

const KEEPALIVE = JSON.stringify({ type: 'KeepAlive' });
const CLOSE_STREAM = JSON.stringify({ type: 'CloseStream' });

function listenUrl(config: DeepgramConfig, sample_rate: number, live: boolean): URL {
  const url = new URL('/v1/listen', config.baseUrl);
  if (live) url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  const params = { model: config.model, encoding: 'linear16', sample_rate: String(sample_rate), channels: '1', punctuate: 'true', diarize: 'true' };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set(live ? 'interim_results' : 'utterances', 'true');
  return url;
}

const unavailable = (message: string, retryable = true) => new Unavailable({ message: `Deepgram: ${message}`, retryable });

/** Opens the socket and resolves once it is open; results and closure feed `mailbox`. */
const connect = (url: URL, apiKey: string, mailbox: Mailbox.Mailbox<AsrResult, Unavailable>) =>
  Effect.async<WebSocket, Unavailable>(resume => {
    const socket = new WebSocket(url, ['token', apiKey]);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => resume(Effect.succeed(socket)));
    socket.addEventListener('message', event => {
      const result = typeof event.data === 'string' ? parseLiveMessage(event.data) : null;
      if (result !== null) mailbox.unsafeOffer(result);
    });
    socket.addEventListener('close', event => {
      const exit = event.code === 1000 ? Exit.void : Exit.fail(unavailable(`stream closed ${event.code} ${event.reason}`));
      mailbox.unsafeDone(exit);
      resume(Exit.fail(unavailable(`connection failed ${event.code}`)));
    });
    return Effect.sync(() => socket.close());
  }).pipe(
    Effect.timeout('10 seconds'),
    Effect.catchTag('TimeoutException', () => Effect.fail(unavailable('connection timed out'))),
  );

function deepgram(config: DeepgramConfig) {
  const apiKey = Option.isSome(config.apiKey)
    ? Effect.succeed(Redacted.value(config.apiKey.value))
    : Effect.fail(unavailable('DEEPGRAM_API_KEY is not configured', false));

  const openStream = (sample_rate: number) =>
    Effect.gen(function* () {
      const key = yield* apiKey;
      // Results are small and few; if persistence stalls, the oldest are dropped and batch reconciliation covers them.
      const mailbox = yield* Mailbox.make<AsrResult, Unavailable>({ capacity: 1024, strategy: 'sliding' });
      const socket = yield* Effect.acquireRelease(connect(listenUrl(config, sample_rate, true), key, mailbox), socket => Effect.sync(() => socket.close()));
      let lastSend = Date.now();
      yield* Effect.forkScoped(
        Effect.repeat(
          Effect.sync(() => Date.now() - lastSend >= 4_000 && socket.readyState === WebSocket.OPEN && socket.send(KEEPALIVE)),
          Schedule.spaced('4 seconds'),
        ),
      );
      return {
        send: samples => {
          if (socket.readyState !== WebSocket.OPEN) return false;
          socket.send(samples);
          lastSend = Date.now();
          return true;
        },
        backlogBytes: () => socket.bufferedAmount,
        results: Mailbox.toStream(mailbox),
        finish: Effect.sync(() => socket.readyState === WebSocket.OPEN && socket.send(CLOSE_STREAM)),
      } satisfies AsrStream;
    });

  const transcribe = (sample_rate: number, samples: Int16Array) =>
    Effect.gen(function* () {
      const key = yield* apiKey;
      const response = yield* Effect.tryPromise(signal =>
        fetch(listenUrl(config, sample_rate, false), {
          method: 'POST',
          headers: { authorization: `Token ${key}`, 'content-type': 'application/octet-stream' },
          body: new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
          signal: AbortSignal.any([signal, AbortSignal.timeout(config.batchTimeoutMs)]),
        }),
      ).pipe(Effect.mapError(error => unavailable(`batch request failed: ${String(error.cause)}`)));
      if (!response.ok) return yield* unavailable(`batch responded ${response.status}`, response.status === 429 || response.status >= 500);
      const body = yield* Effect.tryPromise(() => response.json()).pipe(Effect.mapError(() => unavailable('batch response was not JSON')));
      const { results } = yield* Schema.decodeUnknown(BatchResponse)(body).pipe(Effect.mapError(() => unavailable('unexpected batch response shape', false)));
      return results.utterances.map(
        (utterance): AsrResult => ({
          start_s: utterance.start,
          end_s: utterance.end,
          is_final: true,
          text: utterance.transcript,
          confidence: utterance.confidence,
          speaker: label(utterance.speaker),
        }),
      );
    });

  return SpeechToText.of({ provider: 'deepgram', model: config.model, openStream, transcribe });
}

/** Missing `DEEPGRAM_API_KEY` is not a startup error: every call fails as `Unavailable`, and sessions report degraded ASR. */
export const DeepgramLive = Layer.effect(SpeechToText, Effect.map(deepgramConfig, deepgram));
