/**
 * Joins the answers of two live chunks that share audio. The older chunk may stop inside its last
 * word and the newer one may start inside its first, so both words match as fragments.
 */
/** The part of a provider result the join reads and rewrites. */
interface Timed {
  readonly start_s: number;
  readonly text: string;
}

/** Longest run of repeated words looked for; 0.75 s of speech holds a few. */
const MAX_SEAM_WORDS = 8;

const letters = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Whether `head[0..k)` repeats the last `k` words of `tail`. */
const repeats = (tail: ReadonlyArray<string>, head: ReadonlyArray<string>, k: number) => {
  for (let p = 0; p < k; p++) {
    const [a, b] = [letters(tail[tail.length - k + p]!), letters(head[p]!)];
    const [first, last] = [p === 0, p === k - 1];
    const same = first && last ? a.includes(b) || b.includes(a) : last ? b.startsWith(a) : first ? a.endsWith(b) : a === b;
    if (!same) return false;
  }
  return true;
};

/**
 * `older` is the last answer of the previous chunk and `newer` the first answer of the chunk that
 * repeats its closing audio. Words both heard appear once, in their more complete form; answers
 * that share no words stay two results.
 */
export function joinOverlap<R extends Timed>(older: R, newer: R): ReadonlyArray<R> {
  const tail = older.text.split(/\s+/).filter(word => letters(word) !== '');
  const head = newer.text.split(/\s+/).filter(word => letters(word) !== '');
  for (let k = Math.min(MAX_SEAM_WORDS, tail.length, head.length); k >= 1; k--) {
    if (!repeats(tail, head, k)) continue;
    const shared = head.slice(0, k).map((word, p) => {
      const mine = tail[tail.length - k + p]!;
      return letters(mine).length > letters(word).length ? mine : word;
    });
    const text = [...tail.slice(0, tail.length - k), ...shared, ...head.slice(k)].join(' ');
    return [{ ...newer, start_s: older.start_s, text }];
  }
  return [older, newer];
}
