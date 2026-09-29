/**
 * Cartesia Sonic-3 speech output (plan sections 04 and 09), `POST /tts/bytes` streaming raw
 * PCM16. Interrupting the stream aborts the HTTP request, so cancelled speech stops generating.
 * Reference: https://docs.cartesia.ai/api-reference/tts/bytes (API version 2026-08-14).
 */
import { Unavailable } from '@sanctum/contracts';
import { Config, Context, Effect, Layer, Option, Redacted, Stream } from 'effect';
import { serverConfig } from '../config.ts';

export const CARTESIA_API_VERSION = '2026-08-14';
export const SPEECH_SAMPLE_RATE = 24_000;

export class SpeechSynthesizer extends Context.Tag('sanctum/SpeechSynthesizer')<
  SpeechSynthesizer,
  { readonly synthesize: (text: string) => Stream.Stream<Uint8Array, Unavailable> }
>() {}

export const cartesiaSynthesizer = (options: { readonly apiKey: Option.Option<Redacted.Redacted>; readonly voiceId: Option.Option<string>; readonly baseUrl: string }) =>
  SpeechSynthesizer.of({
    synthesize: text => {
      if (Option.isNone(options.apiKey) || Option.isNone(options.voiceId)) {
        return Stream.fail(new Unavailable({ message: 'Speech output is not configured (CARTESIA_API_KEY, CARTESIA_VOICE_ID)', retryable: false }));
      }
      const [apiKey, voiceId] = [options.apiKey.value, options.voiceId.value];
      const response = Effect.tryPromise({
        try: signal =>
          fetch(`${options.baseUrl}/tts/bytes`, {
            method: 'POST',
            signal,
            headers: { authorization: `Bearer ${Redacted.value(apiKey)}`, 'cartesia-version': CARTESIA_API_VERSION, 'content-type': 'application/json' },
            body: JSON.stringify({
              model_id: 'sonic-3',
              transcript: text,
              voice: { id: voiceId },
              language: 'en',
              output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: SPEECH_SAMPLE_RATE },
            }),
          }),
        catch: () => new Unavailable({ message: 'Cartesia unreachable', retryable: true }),
      }).pipe(
        Effect.filterOrFail(
          reply => reply.ok && reply.body !== null,
          reply => {
            const retryAfter = Number(reply.headers.get('retry-after'));
            return new Unavailable({
              message: `Cartesia returned ${reply.status}`,
              retryable: reply.status === 429 || reply.status >= 500,
              ...(retryAfter > 0 ? { retry_after_ms: retryAfter * 1000 } : {}),
            });
          },
        ),
      );
      return Stream.unwrapScoped(
        Effect.map(response, reply =>
          Stream.fromReadableStream({ evaluate: () => reply.body!, onError: () => new Unavailable({ message: 'Cartesia stream failed', retryable: true }) }),
        ),
      );
    },
  });

export const CartesiaLive = Layer.effect(
  SpeechSynthesizer,
  Effect.map(Config.map(serverConfig, config => config.cartesia), cartesia => cartesiaSynthesizer({ ...cartesia, baseUrl: 'https://api.cartesia.ai' })),
);
