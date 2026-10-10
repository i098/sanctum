/** Provider layers the API and worker entrypoints need for media: private R2 archive storage, speech-to-text and requested speech. */
import { Config, Effect, Layer } from 'effect';
import { engineeringDefaults, serverConfig } from '../config.ts';
import { auraSynthesizer, SpeechSynthesizer } from '../providers/speech.ts';
import { R2ObjectStoreLive } from '../providers/r2.ts';
import { SpeechToText, whisperSpeechToText } from '../providers/whisper.ts';

export type { SpeechToText } from '../providers/whisper.ts';

/** Workers AI Whisper, live and batch; without its settings every call fails visibly. */
export const SpeechToTextLive = Layer.effect(
  SpeechToText,
  Effect.map(Config.map(serverConfig, config => config.workersAi), workersAi => whisperSpeechToText({ workersAi, liveAsr: engineeringDefaults.liveAsr })),
);

export const MediaProvidersLive = Layer.merge(R2ObjectStoreLive, SpeechToTextLive);

/** Workers AI Aura-2; missing credentials fail visibly and nothing is spoken. */
export const SpeechSynthesizerLive = Layer.effect(
  SpeechSynthesizer,
  Effect.map(Config.map(serverConfig, config => config.workersAi), auraSynthesizer),
);
