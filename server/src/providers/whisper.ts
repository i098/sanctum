/**
 * Speech-to-text on Cloudflare Workers AI Whisper (`@cf/openai/whisper-large-v3-turbo`, plan
 * section 09) over REST, sending mono PCM16 WAV. Whisper is batch-only: a live stream buffers PCM
 * and posts short chunks cut at the quietest moment (`engineeringDefaults.liveAsr`), so every
 * result is final and arrives once per chunk. Times are seconds from the first sample sent on
 * that stream or request; callers map them to epoch samples through the anchor they persisted
 * (provider_connections). `vad_filter` skips silence, where Whisper otherwise invents text such
 * as "Thank you.". API per developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo
 * (checked 2026-10-08).
 */
import { Context, Effect, Option, Queue, Redacted, Schema, type Scope, Stream } from 'effect';
import { MAX_FRAME_SAMPLES, Unavailable } from '@sanctum/contracts';
import { wavFile } from './object-store.ts';

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
  /** Bytes queued by `send` but not yet sent to the provider. */
  readonly backlogBytes: () => number;
  /** Results in audio order; ends after `finish` once the provider answered everything, fails on a provider error. */
  readonly results: Stream.Stream<AsrResult, Unavailable>;
  /** Sends the audio still buffered and ends `results` after its answer. */
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

const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

const WhisperResponse = Schema.Struct({
  result: Schema.Struct({ segments: Schema.Array(Schema.Struct({ start: Schema.Number, end: Schema.Number, text: Schema.String })) }),
});

const unavailable = (message: string, retryable = true) => new Unavailable({ message: `Workers AI: ${message}`, retryable });

/** Middle of the quietest 20 ms window in `[min, max)`, so a chunk boundary falls between words. */
function quietestCut(samples: Int16Array, min: number, max: number, frame: number): number {
  let cut = max;
  let lowest = Infinity;
  for (let start = min; start + frame <= max; start += frame) {
    let energy = 0;
    for (let i = start; i < start + frame; i++) energy += samples[i]! * samples[i]!;
    if (energy < lowest) {
      lowest = energy;
      cut = start + (frame >> 1);
    }
  }
  return cut;
}

interface Chunk {
  readonly offset: number;
  readonly samples: Int16Array;
}

interface WhisperConfig {
  /** `serverConfig.workersAi`: the account's REST base URL (`.../accounts/<id>/ai`) and a Workers AI token. */
  readonly workersAi: Option.Option<{ readonly baseUrl: string; readonly apiToken: Redacted.Redacted }>;
  /** `engineeringDefaults.liveAsr`. */
  readonly liveAsr: { readonly minMs: number; readonly maxMs: number; readonly concurrency: number; readonly requestTimeoutMs: number };
}

/** Missing settings are not a startup error: every call fails as `Unavailable`, and sessions report degraded ASR. */
export function whisperSpeechToText(config: WhisperConfig) {
  const limits = config.liveAsr;
  const target = Option.map(config.workersAi, ({ baseUrl, apiToken }) => ({
    url: `${baseUrl}/run/${WHISPER_MODEL}`,
    token: Redacted.value(apiToken),
  }));
  const configured = Option.match(target, {
    onNone: () => Effect.fail(unavailable('WORKERS_AI_ACCOUNT_ID and WORKERS_AI_API_TOKEN are not configured', false)),
    onSome: Effect.succeed,
  });

  const transcribe = (sample_rate: number, samples: Int16Array) =>
    Effect.gen(function* () {
      const { url, token } = yield* configured;
      const wav = wavFile(sample_rate, [new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)]);
      const response = yield* Effect.tryPromise(signal =>
        fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ audio: Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength).toString('base64'), vad_filter: true }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(limits.requestTimeoutMs)]),
        }),
      ).pipe(Effect.mapError(error => unavailable(`request failed: ${String(error.cause)}`)));
      if (!response.ok) return yield* unavailable(`responded ${response.status}`, response.status === 429 || response.status >= 500);
      const body = yield* Effect.tryPromise(() => response.json()).pipe(Effect.mapError(() => unavailable('response was not JSON')));
      const { result } = yield* Schema.decodeUnknown(WhisperResponse)(body).pipe(Effect.mapError(() => unavailable('unexpected response shape', false)));
      return result.segments.flatMap((segment): Array<AsrResult> => {
        const text = segment.text.trim();
        return text === '' ? [] : [{ start_s: segment.start, end_s: segment.end, is_final: true, text, confidence: null, speaker: null }];
      });
    });

  const openStream = (sample_rate: number) =>
    Effect.gen(function* () {
      yield* configured;
      const samplesIn = (ms: number) => Math.round((ms * sample_rate) / 1000);
      const [min, max, frame] = [samplesIn(limits.minMs), samplesIn(limits.maxMs), samplesIn(20)];
      const chunks = yield* Queue.unbounded<Chunk | null>();
      // Under `max` samples stay after each send, and one frame holds at most MAX_FRAME_SAMPLES.
      const buffer = new Int16Array(max + MAX_FRAME_SAMPLES);
      let filled = 0;
      let offset = 0;
      let queued = 0;
      let open = true;
      const enqueue = (length: number) => {
        const samples = buffer.slice(0, length);
        buffer.copyWithin(0, length, filled);
        filled -= length;
        chunks.unsafeOffer({ offset, samples });
        offset += length;
        queued += samples.byteLength;
      };
      const transcribeChunk = ({ offset, samples }: Chunk) => {
        queued -= samples.byteLength;
        const shift = offset / sample_rate;
        return Effect.map(transcribe(sample_rate, samples), results => results.map(result => ({ ...result, start_s: result.start_s + shift, end_s: result.end_s + shift })));
      };
      return {
        send: samples => {
          if (!open) return false;
          buffer.set(samples, filled);
          filled += samples.length;
          while (filled >= max) enqueue(quietestCut(buffer, min, max, frame));
          return true;
        },
        backlogBytes: () => queued,
        results: Stream.fromQueue(chunks).pipe(
          Stream.takeWhile((chunk): chunk is Chunk => chunk !== null),
          Stream.mapEffect(transcribeChunk, { concurrency: limits.concurrency }),
          Stream.flattenIterables,
          Stream.tapError(() => Effect.sync(() => (open = false))),
        ),
        finish: Effect.sync(() => {
          if (!open) return;
          open = false;
          if (filled > 0) enqueue(filled);
          chunks.unsafeOffer(null);
        }),
      } satisfies AsrStream;
    });

  return SpeechToText.of({ provider: 'workers-ai', model: WHISPER_MODEL, openStream, transcribe });
}
