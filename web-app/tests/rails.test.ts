import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showCaption } from '../src/pages/listen/rails.ts';

const CHARS_PER_ROW = 10;
const BAND_ROWS = 2;
const LONG = 'x'.repeat(CHARS_PER_ROW * BAND_ROWS * 2);

/** Minimal DOM line: wraps at `CHARS_PER_ROW` characters, one row = 1 height unit. */
class FakeLine {
  classes = new Set<string>();
  text = '';
  removed = false;
  classList = {
    add: (name: string) => this.classes.add(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)),
  };
  set className(value: string) {
    this.classes = new Set(value.split(' '));
  }
  set textContent(value: string) {
    this.text = value;
  }
  get offsetHeight(): number {
    return Math.ceil(this.text.length / CHARS_PER_ROW);
  }
  animate = () => ({ finished: Promise.resolve() });
  getBoundingClientRect = () => ({ top: 0 });
  remove(): void {
    this.removed = true;
  }
}

class FakeBand {
  children: FakeLine[] = [];
  clientHeight = BAND_ROWS;
  getBoundingClientRect = () => ({ top: 0 });
  append(line: FakeLine): void {
    this.children.push(line);
  }
  querySelector(): FakeLine | null {
    return this.children.find(line => line.classes.has('interim') && !line.classes.has('bye') && !line.removed) ?? null;
  }
  querySelectorAll(selector: string): FakeLine[] {
    const live = this.children.filter(line => !line.removed);
    return selector === '.caption' ? live.filter(line => line.classes.has('caption')) : live.filter(line => !line.classes.has('bye'));
  }
}

function caption(text: string, final = false): string | undefined {
  const band = new FakeBand();
  showCaption(band as never, text, final);
  return band.children[0]?.text;
}

beforeEach(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
  vi.stubGlobal('document', { createElement: () => new FakeLine() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('showCaption fits the band', () => {
  it('shows a caption that already fits whole', () => {
    expect(caption('we keep it')).toBe('we keep it');
  });

  it('drops leading words behind an ellipsis until a long interim fits', () => {
    const shown = caption('we keep the pilot going live on Friday morning');
    expect(shown).toBe('…on Friday morning');
    expect(shown!.length).toBeLessThanOrEqual(CHARS_PER_ROW * BAND_ROWS);
  });

  it('keeps one overlong word whole after the ellipsis', () => {
    expect(caption(`see ${LONG}`)).toBe(`…${LONG}`);
  });

  it('keeps a single word without an ellipsis', () => {
    expect(caption(LONG)).toBe(LONG);
  });
});
