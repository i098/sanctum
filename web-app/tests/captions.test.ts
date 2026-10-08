import type { TranscriptSegment } from '@sanctum/contracts';
import { describe, expect, it, vi } from 'vitest';
import { startCaptions } from '../src/pages/listen/captions.ts';

type Results = { isFinal: boolean; 0: { transcript: string } }[];

function setup(lang: string) {
  vi.stubGlobal('navigator', { language: lang });
  let recognition!: { onresult: (event: { resultIndex: number; results: Results }) => void };
  class Fake {
    continuous = false;
    interimResults = false;
    lang = '';
    onstart = null;
    onresult: ((event: { resultIndex: number; results: Results }) => void) | null = null;
    onerror = null;
    onend = null;
    constructor() {
      recognition = this as never;
    }
    start(): void {}
    abort(): void {}
  }
  let listener!: (segment: TranscriptSegment) => void;
  const shown: string[] = [];
  startCaptions(
    Fake as never,
    next => {
      listener = next;
      return () => undefined;
    },
    { show: (text, final) => shown.push(`${final ? 'final' : 'interim'}:${text}`), clear: () => undefined },
    () => undefined,
  );
  const say = (resultIndex: number, ...parts: [string, boolean][]): void =>
    recognition.onresult({ resultIndex, results: parts.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) });
  const serverFinal = (): void => listener({ status: 'final', text: 'server text' } as TranscriptSegment);
  return { say, serverFinal, shown };
}

describe('browser captions after a server segment', () => {
  it('keeps showing new text in a language written without spaces', () => {
    const { say, serverFinal, shown } = setup('ja-JP');
    say(0, ['今日は会議を始めます', false]);
    serverFinal();
    say(0, ['今日は会議を始めますよろしくお願いします', false]);
    expect(shown.at(-1)).toBe('interim:よろしくお願いします');
  });

  it('skips only words already replaced when the browser revises the interim text', () => {
    const { say, serverFinal, shown } = setup('en-US');
    say(0, ['we keep the pilot', false]);
    serverFinal();
    say(0, ['we keep the pilots', false]);
    expect(shown.at(-1)).toBe('interim:');
    say(0, ['we keep the pilots going live', false]);
    expect(shown.at(-1)).toBe('interim:going live');
  });

  it('shows the whole next utterance after the browser finalises the replaced one', () => {
    const { say, serverFinal, shown } = setup('en-US');
    say(0, ['we keep the pilot', false]);
    serverFinal();
    say(0, ['we keep the pilot', true], ['review it Friday', false]);
    expect(shown.at(-1)).toBe('interim:review it Friday');
  });
});
