import { describe, expect, it } from 'vitest';
import { joinOverlap, stitchBatch } from '../src/providers/asr-seam.ts';

interface Said {
  readonly text: string;
  readonly start_s: number;
  readonly end_s: number;
}

const said = (text: string, start_s: number, end_s: number): Said => ({ text, start_s, end_s });

describe('joinOverlap', () => {
  it('repeats no word both chunks heard', () => {
    const [joined, ...others] = joinOverlap(said('we chose the', 1, 5), said('the Northwind freight', 4, 8));
    expect(others).toEqual([]);
    expect(joined).toEqual(said('we chose the Northwind freight', 1, 8));
  });

  it('recovers a word cut in half by keeping its complete form', () => {
    const [joined] = joinOverlap(said('We chose North.', 0, 5), said('Northwind freight for shipping.', 4, 9));
    expect(joined?.text).toBe('We chose Northwind freight for shipping.');
  });

  it('keeps two results when the answers share no word', () => {
    expect(joinOverlap(said('hello there', 0, 2), said('good morning', 3, 5))).toHaveLength(2);
  });
});

describe('stitchBatch', () => {
  const batch = (results: Said[], repeated_s: number) => ({ start_s: 0, end_s: 10, repeated_s, results });

  it('passes a batch through when nothing closes inside the repeat, settled only before the repeat', () => {
    const results = [said('one', 1, 3), said('two', 4, 6)];
    expect(stitchBatch(null, batch(results, 1))).toEqual({ held: null, batch: { start_s: 0, end_s: 10, settled_s: 9, results } });
  });

  it('settles a batch without answers only before the repeat, which the next batch may still answer', () => {
    expect(stitchBatch(null, batch([], 1))).toEqual({ held: null, batch: { start_s: 0, end_s: 10, settled_s: 9, results: [] } });
  });

  it('holds the answer closing inside the repeat and ends the span where it starts', () => {
    const stitched = stitchBatch(null, batch([said('one', 1, 3), said('chose North', 8.5, 10)], 1));
    expect(stitched.held).toEqual(said('chose North', 8.5, 10));
    expect(stitched.batch).toEqual({ start_s: 0, end_s: 8.5, settled_s: 8.5, results: [said('one', 1, 3)] });
  });

  it('never holds without a repeat', () => {
    const stitched = stitchBatch(null, batch([said('one', 8, 10.2)], 0));
    expect(stitched.held).toBeNull();
    expect(stitched.batch.results).toHaveLength(1);
  });

  it('joins the held answer with the next first answer and starts the span at the held start', () => {
    const held = said('We chose North', 8.5, 10);
    const stitched = stitchBatch(held, { start_s: 9, end_s: 19, repeated_s: 0, results: [said('Northwind freight', 9.2, 12)] });
    expect(stitched.held).toBeNull();
    expect(stitched.batch).toEqual({ start_s: 8.5, end_s: 19, results: [said('We chose Northwind freight', 8.5, 12)] });
  });

  it('releases the held answer when the next batch has no answer', () => {
    const held = said('We chose', 8.5, 10);
    const stitched = stitchBatch(held, { start_s: 9, end_s: 19, repeated_s: 0, results: [] });
    expect(stitched.batch).toEqual({ start_s: 8.5, end_s: 19, results: [held] });
  });

  it('never ends a span before its start', () => {
    const stitched = stitchBatch(null, batch([said('only', 0, 10)], 1));
    expect(stitched.batch).toEqual({ start_s: 0, end_s: 0, settled_s: 0, results: [] });
  });
});
