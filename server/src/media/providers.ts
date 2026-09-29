/** Provider layers the API and worker entrypoints need for media: private R2 archive storage and speech-to-text. */
import { Layer } from 'effect';
import { DeepgramLive } from '../providers/deepgram.ts';
import { R2ObjectStoreLive } from '../providers/r2.ts';

export type { SpeechToText } from '../providers/deepgram.ts';

export const MediaProvidersLive = Layer.merge(R2ObjectStoreLive, DeepgramLive);
