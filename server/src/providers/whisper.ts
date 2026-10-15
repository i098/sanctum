/**
 * Speech-to-text on Cloudflare Workers AI Whisper (`@cf/openai/whisper-large-v3-turbo`, plan
 * section 09) over REST, sending mono PCM16 WAV. Whisper is batch-only: a live stream buffers PCM
 * and posts short chunks cut at the quietest moment (`engineeringDefaults.liveAsr`). A cut with sound on it
 * may fall inside a word, so the next chunk starts `overlapMs` before it and `joinOverlap` repeats no word;
 * every result is final. Times are seconds from the first sample sent on
 * that stream or request; callers map them to epoch samples through the anchor they persisted
 * (provider_connections). Whisper invents text such as "Thank you." on silence and room noise, so
 * audio without sustained sound is never sent, `vad_filter` drops silence inside a request, and a
 * segment Whisper scores as likely no speech is dropped. API and segment fields per
 * developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo (checked 2026-10-09).
 */
import { Context, Effect, Option, Queue, Redacted, Schema, type Scope, Stream } from 'effect';
import { MAX_FRAME_SAMPLES, Unavailable } from '@sanctum/contracts';
import { stitchBatch } from './asr-seam.ts';
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

/** What the provider answered for the audio span `[start_s, end_s)`; the span is finished even when `results` is empty. */
export interface AsrBatch {
  readonly start_s: number;
  readonly end_s: number;
  readonly results: ReadonlyArray<AsrResult>;
}

export interface AsrStream {
  /** Queues audio without waiting; `false` once the connection is gone. */
  readonly send: (samples: Int16Array) => boolean;
  /** Bytes queued by `send` but not yet sent to the provider. */
  readonly backlogBytes: () => number;
  /** Answers in audio order; ends after `finish` once the provider answered everything, fails on a provider error. Audio the provider did not answer is absent. */
  readonly results: Stream.Stream<AsrBatch, Unavailable>;
  /** Sends the audio still buffered and ends `results` after its answer. */
  readonly finish: Effect.Effect<void>;
}

export class SpeechToText extends Context.Tag('sanctum/SpeechToText')<
  SpeechToText,
  {
    readonly provider: string;
    readonly model: string;
    readonly openStream: (sample_rate: number, behind: (offset: number) => Effect.Effect<void>) => Effect.Effect<AsrStream, Unavailable, Scope.Scope>;
    readonly transcribe: (sample_rate: number, samples: Int16Array) => Effect.Effect<ReadonlyArray<AsrResult>, Unavailable>;
  }
>() {}

const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

/**
 * Whisper's own `no_speech_threshold` default. The provider drops any segment whose `no_speech_prob`
 * is above it, whatever its `avg_logprob`, because confident filler like "Thank you." on silence must not arrive.
 */
const NO_SPEECH_PROB = 0.6;
/** Sound must stay at the speech floor this long; a click, tap or breath in a quiet chunk is shorter than one word. */
const SUSTAINED_SOUND_MS = 100;

const WhisperResponse = Schema.Struct({
  result: Schema.Struct({
    text: Schema.String,
    segments: Schema.optional(
      Schema.Array(Schema.Struct({ start: Schema.Number, end: Schema.Number, text: Schema.String, no_speech_prob: Schema.optionalWith(Schema.Number, { default: () => 0 }) })),
    ),
  }),
});

const unavailable = (message: string, retryable = true, retry_after_ms?: number) =>
  new Unavailable({ message: `Workers AI: ${message}`, retryable, ...(retry_after_ms === undefined ? {} : { retry_after_ms }) });

const meanSquare = (samples: Int16Array, from: number, to: number) => {
  let energy = 0;
  for (let i = from; i < to; i++) energy += samples[i]! * samples[i]!;
  return energy / (to - from);
};

/** Middle of the quietest 20 ms window in `[min, max)`, so a chunk boundary falls between words. */
function quietestCut(samples: Int16Array, min: number, max: number, frame: number): number {
  let cut = max;
  let lowest = Infinity;
  for (let start = min; start + frame <= max; start += frame) {
    const energy = meanSquare(samples, start, start + frame);
    if (energy < lowest) {
      lowest = energy;
      cut = start + (frame >> 1);
    }
  }
  return cut;
}

/** True when `SUSTAINED_SOUND_MS` of consecutive 20 ms windows reach `floorRms`; other audio is never sent, so silence costs no allocation. */
function hasSustainedSound(samples: Int16Array, frame: number, floorRms: number): boolean {
  const needed = SUSTAINED_SOUND_MS / 20;
  let run = 0;
  for (let start = 0; start < samples.length; start += frame) {
    run = meanSquare(samples, start, Math.min(start + frame, samples.length)) >= floorRms * floorRms ? run + 1 : 0;
    if (run >= needed) return true;
  }
  return false;
}

interface Chunk {
  /** First sample this chunk answers for; the `lead` samples before it repeat the previous chunk's end. */
  readonly offset: number;
  readonly lead: number;
  /** Samples at the end of this chunk that the next chunk repeats. */
  readonly repeated: number;
  readonly samples: Int16Array;
}

/** An answer plus how much of its end the next answer repeats, for `stitch`. */
type Answered = AsrBatch & { readonly repeated_s: number };

interface WhisperConfig {
  /** `serverConfig.workersAi`: the account's REST base URL (`.../accounts/<id>/ai`) and a Workers AI token. */
  readonly workersAi: Option.Option<{ readonly baseUrl: string; readonly apiToken: Redacted.Redacted }>;
  /** `engineeringDefaults.liveAsr`. */
  readonly liveAsr: {
    readonly minMs: number;
    readonly maxMs: number;
    readonly overlapMs: number;
    readonly concurrency: number;
    readonly hedgeMs: number;
    readonly requestTimeoutMs: number;
    readonly speechFloorRms: number;
    readonly rateLimitBackoffMs: number;
  };
}

const failedResponse = (response: Response, rateLimitBackoffMs: number) => {
  const rateLimited = response.status === 429;
  const retryAfter = Number(response.headers.get('retry-after'));
  return unavailable(`responded ${response.status}`, rateLimited || response.status >= 500, rateLimited ? (retryAfter > 0 ? retryAfter * 1000 : rateLimitBackoffMs) : undefined);
};

const toResults = (result: typeof WhisperResponse.Type.result) => {
  if (result.segments === undefined) return result.text.trim() === '' ? Effect.succeed([]) : Effect.fail(unavailable('response has text without segments', false));
  return Effect.succeed(
    result.segments.flatMap((segment): Array<AsrResult> => {
      const text = segment.text.trim();
      return text === '' || segment.no_speech_prob > NO_SPEECH_PROB
        ? []
        : [{ start_s: segment.start, end_s: segment.end, is_final: true, text, confidence: null, speaker: null }];
    }),
  );
};

const requestSegments = (url: string, token: string, wav: Uint8Array, limits: WhisperConfig['liveAsr']) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise(signal =>
      fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ audio: Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength).toString('base64'), vad_filter: true }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(limits.requestTimeoutMs)]),
      }),
    ).pipe(Effect.mapError(error => unavailable(`request failed: ${String(error.cause)}`)));
    if (!response.ok) return yield* failedResponse(response, limits.rateLimitBackoffMs);
    const body = yield* Effect.tryPromise(() => response.json()).pipe(Effect.mapError(() => unavailable('response was not JSON')));
    const { result } = yield* Schema.decodeUnknown(WhisperResponse)(body).pipe(Effect.mapError(() => unavailable('unexpected response shape', false)));
    return yield* toResults(result);
  });

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
      if (!hasSustainedSound(samples, Math.round((20 * sample_rate) / 1000), limits.speechFloorRms)) return [];
      return yield* requestSegments(url, token, wavFile(sample_rate, [new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)]), limits);
    });

  const openStream = (sample_rate: number, behind: (offset: number) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      yield* configured;
      const samplesIn = (ms: number) => Math.round((ms * sample_rate) / 1000);
      const [min, max, frame, overlap] = [samplesIn(limits.minMs), samplesIn(limits.maxMs), samplesIn(20), samplesIn(limits.overlapMs)];
      const chunks = yield* Queue.unbounded<Chunk | null>();
      // The `lead` samples repeated from the last send plus under `max` samples stay after each send, and one frame holds at most MAX_FRAME_SAMPLES.
      const buffer = new Int16Array(overlap + max + MAX_FRAME_SAMPLES);
      let filled = 0;
      let lead = 0;
      let offset = 0;
      let queued = 0;
      let pausedUntil = 0;
      let open = true;
      /** `repeated` samples at the end of this chunk start the next one: a cut with sound on it may fall inside a word, a quiet cut falls between words. */
      const enqueue = (length: number, repeated: number) => {
        const samples = buffer.slice(0, length);
        chunks.unsafeOffer({ offset, lead, repeated, samples });
        offset += length - lead;
        queued += samples.byteLength;
        lead = repeated;
        buffer.copyWithin(0, length - lead, filled);
        filled -= length - lead;
      };
      const enqueueCut = (cut: number) => {
        const sound = meanSquare(buffer, cut - (frame >> 1), cut + (frame >> 1)) >= limits.speechFloorRms ** 2;
        enqueue(cut, sound ? Math.min(overlap, cut) : 0);
      };
      const transcribeChunk = ({ offset, lead, repeated, samples }: Chunk): Effect.Effect<ReadonlyArray<Answered | null>, Unavailable> => {
        queued -= samples.byteLength;
        const shift = (offset - lead) / sample_rate;
        const skipped = Effect.as(behind(offset), [null] as ReadonlyArray<Answered | null>);
        if (Date.now() < pausedUntil) return skipped;
        const request = transcribe(sample_rate, samples);
        // A slow answer holds back every later one, so a chunk still unanswered after `hedgeMs` is sent again; the loser is cancelled.
        // The duplicate is never sent during a 429 pause and never wins by failing: the original settles the chunk then.
        const hedge = Effect.suspend(() => (Date.now() < pausedUntil ? Effect.never : request)).pipe(Effect.delay(limits.hedgeMs), Effect.catchAll(() => Effect.never));
        return request.pipe(
          Effect.raceFirst(hedge),
          Effect.map(results => [
            {
              start_s: offset / sample_rate,
              end_s: shift + samples.length / sample_rate,
              repeated_s: repeated / sample_rate,
              results: results.map(result => ({ ...result, start_s: result.start_s + shift, end_s: result.end_s + shift })),
            },
          ]),
          Effect.catchIf(
            error => error.retry_after_ms !== undefined,
            error => {
              pausedUntil = Date.now() + error.retry_after_ms!;
              return skipped;
            },
          ),
        );
      };
      // The answer closing a chunk whose end the next chunk repeats may stop inside a word that chunk hears whole, so it waits for that chunk's first answer.
      // Coverage stops where the held answer starts, so audio whose text is not persisted is never recorded as covered.
      let held: AsrResult | null = null;
      const flushHeld = (): ReadonlyArray<AsrBatch> => {
        const flushed = held;
        held = null;
        return flushed === null ? [] : [{ start_s: flushed.start_s, end_s: flushed.end_s, results: [flushed] }];
      };
      // A skipped chunk breaks adjacency: the next answer repeats the skipped audio, not the held answer's.
      const stitch = (answered: Answered | null): ReadonlyArray<AsrBatch> => {
        if (answered === null) return flushHeld();
        const stitched = stitchBatch(held, answered);
        held = stitched.held;
        return [stitched.batch];
      };
      return {
        send: samples => {
          if (!open) return false;
          buffer.set(samples, filled);
          filled += samples.length;
          while (filled >= lead + max) enqueueCut(quietestCut(buffer, lead + min, lead + max, frame));
          return true;
        },
        backlogBytes: () => queued,
        results: Stream.fromQueue(chunks).pipe(
          Stream.takeWhile((chunk): chunk is Chunk => chunk !== null),
          Stream.mapEffect(transcribeChunk, { concurrency: limits.concurrency }),
          Stream.flattenIterables,
          Stream.mapConcat(stitch),
          Stream.concat(Stream.suspend(() => Stream.fromIterable(flushHeld()))),
          Stream.tapError(() => Effect.sync(() => (open = false))),
        ),
        finish: Effect.sync(() => {
          if (!open) return;
          open = false;
          if (filled > lead) enqueue(filled, 0);
          chunks.unsafeOffer(null);
        }),
      } satisfies AsrStream;
    });

  return SpeechToText.of({ provider: 'workers-ai', model: WHISPER_MODEL, openStream, transcribe });
}
