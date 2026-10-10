/**
 * Workers AI Aura-2 requested speech, streamed as mono PCM16 little-endian at 24 kHz.
 * REST returns raw PCM for these controls despite its audio/mpeg header; see release evidence.
 * Reference: https://developers.cloudflare.com/workers-ai/models/aura-2-en/
 */
import { Unavailable } from '@sanctum/contracts';
import { Context, Effect, Option, Redacted, Stream } from 'effect';

export const SPEECH_MODEL = '@cf/deepgram/aura-2-en';
export const SPEECH_SAMPLE_RATE = 24_000;

export class SpeechSynthesizer extends Context.Tag('sanctum/SpeechSynthesizer')<
  SpeechSynthesizer,
  { readonly synthesize: (text: string) => Stream.Stream<Uint8Array, Unavailable> }
>() {}

export const auraSynthesizer = (workersAi: Option.Option<{ readonly baseUrl: string; readonly apiToken: Redacted.Redacted }>) =>
  SpeechSynthesizer.of({
    synthesize: text => {
      if (Option.isNone(workersAi)) {
        return Stream.fail(new Unavailable({ message: 'Speech output is not configured (WORKERS_AI_ACCOUNT_ID, WORKERS_AI_API_TOKEN)', retryable: false }));
      }
      const { baseUrl, apiToken } = workersAi.value;
      return Stream.unwrapScoped(Effect.gen(function* () {
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          controller => Effect.sync(() => controller.abort()),
        );
        const reply = yield* Effect.tryPromise({
          try: () => fetch(`${baseUrl}/run/${SPEECH_MODEL}`, {
            method: 'POST',
            signal: controller.signal,
            headers: { authorization: `Bearer ${Redacted.value(apiToken)}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text, speaker: 'luna', encoding: 'linear16', container: 'none', sample_rate: SPEECH_SAMPLE_RATE }),
          }),
          catch: () => new Unavailable({ message: 'Workers AI speech unreachable', retryable: true }),
        }).pipe(Effect.filterOrFail(
          reply => reply.ok && reply.body !== null,
          reply => {
            const retryAfter = Number(reply.headers.get('retry-after'));
            return new Unavailable({
              message: `Workers AI speech returned ${reply.status}`,
              retryable: reply.status === 429 || reply.status >= 500,
              ...(retryAfter > 0 ? { retry_after_ms: retryAfter * 1000 } : {}),
            });
          },
        ));
        // HTTP chunks can split a sample; the browser must receive only whole PCM16 samples.
        let pending: number | undefined;
        return Stream.fromReadableStream({
          evaluate: () => reply.body!,
          onError: () => new Unavailable({ message: 'Workers AI speech stream failed', retryable: true }),
        }).pipe(
          Stream.mapConcat(bytes => {
            const parts: Uint8Array[] = [];
            if (pending !== undefined && bytes.byteLength > 0) {
              parts.push(Uint8Array.of(pending, bytes[0]!));
              pending = undefined;
              bytes = bytes.subarray(1);
            }
            if (bytes.byteLength % 2 !== 0) pending = bytes[bytes.byteLength - 1];
            const length = bytes.byteLength - bytes.byteLength % 2;
            if (length > 0) parts.push(bytes.subarray(0, length));
            return parts;
          }),
          Stream.concat(Stream.suspend(() => pending === undefined ? Stream.empty
            : Stream.fail(new Unavailable({ message: 'Workers AI speech ended with an incomplete PCM16 sample', retryable: true })))),
        );
      }));
    },
  });
