/** Provider layers the API and worker entrypoints need for media: private R2 archive storage, speech-to-text and requested speech. */
import { Config, Effect, Layer } from 'effect';
import { serverConfig } from '../config.ts';
import { cartesiaSynthesizer, SpeechSynthesizer } from '../providers/cartesia.ts';
import { DeepgramLive } from '../providers/deepgram.ts';
import { R2ObjectStoreLive } from '../providers/r2.ts';

export type { SpeechToText } from '../providers/deepgram.ts';

export const MediaProvidersLive = Layer.merge(R2ObjectStoreLive, DeepgramLive);

/** Cartesia text-to-speech; without an API key every synthesis fails visibly and nothing is spoken. */
export const SpeechSynthesizerLive = Layer.effect(
  SpeechSynthesizer,
  Effect.map(Config.map(serverConfig, config => config.cartesia), cartesia => cartesiaSynthesizer({ ...cartesia, baseUrl: 'https://api.cartesia.ai' })),
);
