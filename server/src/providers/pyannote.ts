/**
 * Optional pyannoteAI diarization (plan section 09): batch diarization/identification over an
 * assembled meeting cut and a Live-1 streaming session. Enabled only when an operator selects
 * `SANCTUM_DIARIZATION=pyannote` and supplies `PYANNOTE_API_KEY`; otherwise every call fails
 * with `Unavailable`. Limits below were read from docs.pyannote.ai (API reference, streaming
 * tutorial) in September 2026; re-verify before changing them.
 */
import { FetchHttpClient, HttpClient, HttpClientRequest } from '@effect/platform';
import { Unavailable } from '@sanctum/contracts';
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from 'effect';

export const pyannoteLimits = {
  apiBase: 'https://api.pyannote.ai/v1',
  batchModel: 'precision-3',
  liveModel: 'live-1',
  /** Live-1 input: 16 kHz mono float32 little-endian, 100 ms per binary message. */
  liveSampleRate: 16_000,
  liveChunkSamples: 1_600,
  /** The stream closes after 5 s without audio; callers send silence rather than nothing. */
  idleTimeoutMs: 5_000,
  maxStreamMs: 5 * 3_600_000,
  /** Rotate ten minutes before the hard limit so the replacement stream is open in time. */
  rotateAfterMs: 5 * 3_600_000 - 10 * 60_000,
  maxLiveSpeakers: 8,
  pollIntervalMs: 5_000,
  maxPolls: 120,
} as const;

export interface DiarizedTurn {
  /** Provider-local label, e.g. `SPEAKER_00`; meaningful only within one stream or job. */
  readonly label: string;
  readonly start_s: number;
  readonly end_s: number;
  readonly confidence: number | null;
}

/** Per diarization label, 0-100 similarity to each submitted voiceprint label. */
export interface VoiceMatch {
  readonly label: string;
  readonly scores: Readonly<Record<string, number>>;
}

export interface BatchDiarization {
  readonly model: string;
  readonly turns: ReadonlyArray<DiarizedTurn>;
  readonly matches: ReadonlyArray<VoiceMatch>;
}

interface PyannoteService {
  readonly configured: boolean;
  /** Diarizes the audio at `url`; with voiceprints this is `/identify`, which also scores each label against them. */
  readonly diarize: (input: { readonly url: string; readonly voiceprints: ReadonlyArray<{ readonly label: string; readonly voiceprint: string }> }) => Effect.Effect<BatchDiarization, Unavailable>;
  /** Opens a Live-1 session; `url` is a single-use WebSocket URL carrying no team credential. */
  readonly createLiveStream: () => Effect.Effect<{ readonly id: string; readonly url: string }, Unavailable>;
}

export class PyannoteClient extends Context.Tag('sanctum/PyannoteClient')<PyannoteClient, PyannoteService>() {}

const Status = Schema.Literal('pending', 'created', 'running', 'succeeded', 'canceled', 'failed');
const Created = Schema.Struct({ jobId: Schema.String, status: Status });
const Output = Schema.Struct({
  diarization: Schema.optional(Schema.Array(Schema.Struct({ speaker: Schema.String, start: Schema.Number, end: Schema.Number, confidence: Schema.optional(Schema.Number) }))),
  voiceprints: Schema.optional(Schema.Array(Schema.Struct({ speaker: Schema.String, confidence: Schema.Record({ key: Schema.String, value: Schema.Number }) }))),
});
const JobState = Schema.Struct({ status: Status, output: Schema.optional(Output) });
const LiveStream = Schema.Struct({ id: Schema.String, url: Schema.String });

const unavailable = (message: string, retryable: boolean) => new Unavailable({ message: `pyannote: ${message}`, retryable });

/** Client over an HTTP client; `apiKey: null` yields a client whose calls explain it is not configured. */
export const makePyannote = (apiKey: Redacted.Redacted | null) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const call = <A, I>(request: HttpClientRequest.HttpClientRequest, schema: Schema.Schema<A, I>) =>
      Effect.gen(function* () {
        if (apiKey === null) return yield* unavailable('diarization is not configured (SANCTUM_DIARIZATION=pyannote and PYANNOTE_API_KEY)', false);
        const response = yield* http.execute(HttpClientRequest.bearerToken(request, Redacted.value(apiKey)));
        if (response.status >= 300) return yield* unavailable(`HTTP ${response.status}`, response.status === 429 || response.status >= 500);
        return yield* Effect.flatMap(response.json, Schema.decodeUnknown(schema));
      }).pipe(
        Effect.scoped,
        Effect.catchTags({ RequestError: error => unavailable(error.message, true), ResponseError: error => unavailable(error.message, true), ParseError: () => unavailable('unexpected response', false) }),
      );
    const submit = (path: string, body: unknown) => call(HttpClientRequest.bodyUnsafeJson(HttpClientRequest.post(`${pyannoteLimits.apiBase}${path}`), body), Created);
    const awaitJob = (jobId: string) =>
      Effect.gen(function* () {
        for (let poll = 0; poll < pyannoteLimits.maxPolls; poll++) {
          const job = yield* call(HttpClientRequest.get(`${pyannoteLimits.apiBase}/jobs/${jobId}`), JobState);
          if (job.status === 'succeeded' && job.output !== undefined) return job.output;
          if (job.status === 'failed' || job.status === 'canceled') return yield* unavailable(`job ${jobId} ${job.status}`, false);
          yield* Effect.sleep(pyannoteLimits.pollIntervalMs);
        }
        return yield* unavailable(`job ${jobId} did not finish`, true);
      });
    return {
      configured: apiKey !== null,
      diarize: ({ url, voiceprints }) =>
        Effect.gen(function* () {
          const created = voiceprints.length > 0
            ? yield* submit('/identify', { url, voiceprints, matching: { exclusive: true, threshold: 0 } })
            : yield* submit('/diarize', { url, model: pyannoteLimits.batchModel, turnLevelConfidence: true });
          const output = yield* awaitJob(created.jobId);
          return {
            model: pyannoteLimits.batchModel,
            turns: (output.diarization ?? []).map(turn => ({ label: turn.speaker, start_s: turn.start, end_s: turn.end, confidence: turn.confidence ?? null })),
            matches: (output.voiceprints ?? []).map(match => ({ label: match.speaker, scores: match.confidence })),
          };
        }),
      createLiveStream: () => call(HttpClientRequest.bodyUnsafeJson(HttpClientRequest.post(`${pyannoteLimits.apiBase}/live`), {}), LiveStream),
    } satisfies PyannoteService;
  });

export const PyannoteLive = Layer.effect(
  PyannoteClient,
  Effect.gen(function* () {
    const selected = yield* Config.literal('none', 'pyannote')('SANCTUM_DIARIZATION').pipe(Config.withDefault('none'));
    const key = yield* Config.option(Config.redacted('PYANNOTE_API_KEY'));
    return yield* makePyannote(selected === 'pyannote' ? Option.getOrNull(key) : null);
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

export interface LiveSocket {
  send(data: string | ArrayBuffer): void;
}

/**
 * One Live-1 stream: converts capture PCM16 to 16 kHz float32 100 ms messages and turns
 * `diarization_speaker_start`/`_end` events into completed turns (overlapping turns stay
 * separate). Plain TypeScript: this runs per audio frame, outside Effect.
 */
export class LiveDiarization {
  readonly turns: Array<DiarizedTurn> = [];
  readonly errors: Array<string> = [];
  private readonly chunk = new Float32Array(pyannoteLimits.liveChunkSamples);
  private filled = 0;
  private carrySum = 0;
  private carryCount = 0;
  private readonly open = new Map<string, number>();
  private readonly factor: number;
  private readonly socket: LiveSocket;

  constructor(socket: LiveSocket, sourceRate: number) {
    this.socket = socket;
    // ponytail: boxcar decimation for integer multiples of 16 kHz only; 44.1/22.05 kHz need a verified resampler first.
    if (sourceRate % pyannoteLimits.liveSampleRate !== 0) throw new Error(`Live diarization needs a multiple of 16 kHz, got ${sourceRate} Hz`);
    this.factor = sourceRate / pyannoteLimits.liveSampleRate;
  }

  push(samples: Int16Array): void {
    for (const sample of samples) {
      this.carrySum += sample;
      if (++this.carryCount < this.factor) continue;
      this.chunk[this.filled++] = this.carrySum / this.carryCount / 32_768;
      this.carrySum = 0;
      this.carryCount = 0;
      if (this.filled === this.chunk.length) this.flush();
    }
  }

  receive(message: string): void {
    const event = JSON.parse(message) as { type?: string; message?: string; data?: { timestamp?: number; speaker?: string } };
    const { speaker, timestamp } = event.data ?? {};
    if (event.type === 'error') this.errors.push(event.message ?? 'unknown stream error');
    if (speaker === undefined || timestamp === undefined) return;
    if (event.type === 'diarization_speaker_start') this.open.set(speaker, timestamp);
    const start = this.open.get(speaker);
    if (event.type === 'diarization_speaker_end' && start !== undefined) {
      this.open.delete(speaker);
      this.turns.push({ label: speaker, start_s: start, end_s: timestamp, confidence: null });
    }
  }

  /** True once the stream should be replaced; the replacement gets a new provider connection and new labels. */
  static mustRotate(elapsedMs: number): boolean {
    return elapsedMs >= pyannoteLimits.rotateAfterMs;
  }

  /** Pads the last partial message with silence and asks the server to flush final events. */
  end(): void {
    if (this.filled > 0) {
      this.chunk.fill(0, this.filled);
      this.flush();
    }
    this.socket.send(JSON.stringify({ type: 'end_of_stream' }));
  }

  private flush(): void {
    this.socket.send(this.chunk.slice().buffer);
    this.filled = 0;
  }
}
