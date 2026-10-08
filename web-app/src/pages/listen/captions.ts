/**
 * Word-by-word live captions from the browser's own speech recognition (Web Speech API; in
 * Chrome it runs on Google's speech service). Display-only: the words go to the transcript rail
 * and nowhere else. They are never sent to the server, stored, or fed to the speech gate; the
 * server's transcript segments stay the saved transcript and replace them as they arrive.
 */
import type { TranscriptSegment } from '@sanctum/contracts';

interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<{ readonly isFinal: boolean; readonly 0: { readonly transcript: string } }>;
}

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}

type RecognitionConstructor = new () => Recognition;

/** Where the captions show: `show` sets the utterance's words (a final one stays), `clear` removes every caption. */
interface CaptionRail {
  show(text: string, final: boolean): void;
  clear(): void;
}

type SubscribeTranscript = (listener: (segment: TranscriptSegment) => void) => () => void;

interface SpeechWindow {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
}

/** The browser's recognition, if it has one (Firefox has none). TypeScript's DOM types lack it; Chrome ships it prefixed. */
export function browserRecognition(): RecognitionConstructor | undefined {
  const scope = window as SpeechWindow;
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/**
 * Runs captions into `rail` until the returned cleanup, restarting each time the browser ends a
 * session. `onActive` reports whether captions run; on an error they stop and the rail keeps
 * only server segments.
 *
 * Rule that never shows words twice: a final server segment replaces every browser word shown
 * before it arrived. The rail drops all captions, and the words of the current utterance shown so
 * far are skipped from then on. It holds because the browser recognises faster than a server chunk
 * returns; words shown after the chunk ended reappear with the next server segment.
 */
export function startCaptions(Recognition: RecognitionConstructor, subscribeTranscript: SubscribeTranscript, rail: CaptionRail, onActive: (active: boolean) => void): () => void {
  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language;
  /** Raw words of the current utterance not yet final. */
  let interim = '';
  /** Leading words of the current utterance a server segment already replaced. */
  let skip = 0;
  /** `resultIndex` of the utterance `skip` belongs to. */
  let utterance = 0;
  const segmenter = new Intl.Segmenter(recognition.lang, { granularity: 'word' });
  /** Words are counted per the language's own word boundaries, so text written without spaces (ja, zh) still counts. */
  const wordEnds = (text: string): number[] => [...segmenter.segment(text)].filter(part => part.isWordLike).map(part => part.index + part.segment.length);
  const unseen = (text: string): string => (skip === 0 ? text : text.slice(wordEnds(text)[skip - 1] ?? text.length)).trim();

  const stop = (): void => {
    recognition.onend = null;
    recognition.abort();
    rail.clear();
    onActive(false);
  };
  recognition.onstart = () => onActive(true);
  recognition.onresult = event => {
    if (event.resultIndex !== utterance) {
      utterance = event.resultIndex;
      skip = 0;
    }
    interim = '';
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index]!;
      if (!result.isFinal) interim += result[0].transcript;
      else {
        rail.show(unseen(result[0].transcript), true);
        skip = 0;
      }
    }
    rail.show(unseen(interim), false);
  };
  recognition.onerror = event => {
    // The browser ends the session after these and it restarts; any other error (not-allowed, network, …) stops captions.
    if (event.error !== 'no-speech' && event.error !== 'aborted') stop();
  };
  recognition.onend = () => {
    interim = '';
    skip = 0;
    utterance = 0;
    rail.show('', false);
    try {
      recognition.start();
    } catch {
      stop();
    }
  };
  const unsubscribe = subscribeTranscript(segment => {
    if (segment.status !== 'final' || segment.text.trim() === '') return;
    skip = wordEnds(interim).length;
    rail.clear();
  });
  try {
    recognition.start();
  } catch {
    stop();
  }
  return () => {
    unsubscribe();
    stop();
  };
}
