/**
 * Whisper's `initial_prompt` for one live session: the distinct capitalised terms this capture heard, newest
 * first, then the names of the workspace's committed items, newest item first. Whisper spells a name it was
 * told about that way again, so "Falcon" said earlier and "Asana" from an earlier meeting's item are heard
 * right. Bounded: a long prompt dilutes each name (measured on the soak clips, docs/DECISIONS.md).
 */
export const HEARD_TERMS = 15;
export const PROMPT_TERMS = 20;
const TERM_CHARS = 40;
/** Words Whisper capitalises after a comma in run-on speech; they are not names. */
const NOT_NAMES = new Set(['and', 'but', 'so', 'or', 'okay', 'ok', 'yeah', 'yes', 'no', 'oh', 'well', 'um', 'uh', 'the', 'a', 'an', 'it', 'we', 'you', 'they', 'this', 'that', 'what', 'how', 'why']);

/** Capitalised words that do not start a sentence: "Falcon", "Asana", "Sanctum"; never "I" or "I'm". */
export const properNouns = (text: string): Array<string> => {
  const terms: Array<string> = [];
  const words = text.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (/[.!?]["')\]]*$/.test(words[i - 1]!) || !/^\p{Lu}[\p{L}\p{N}'’-]+$/u.test(word) || /^I['’]/.test(word) || NOT_NAMES.has(word.toLowerCase()) || word.length > TERM_CHARS) continue;
    terms.push(word);
  }
  return terms;
};

/** `items`: the texts of the visible committed items, newest first, or none; each name keeps its first appearance. */
export const asrVocabulary = (items: Iterable<string>) => {
  const known = new Map<string, string>();
  for (const text of items) for (const term of properNouns(text)) if (!known.has(term.toLowerCase())) known.set(term.toLowerCase(), term);
  /** Oldest first; a repeated term moves to the newest place. */
  let heard = new Map<string, string>();
  return {
    /** Replaces the heard names with the newest `HEARD_TERMS` of the current meeting's finals, given oldest first. */
    hear: (finals: Iterable<string>) => {
      const terms = new Map<string, string>();
      for (const text of finals) {
        for (const term of properNouns(text)) {
          terms.delete(term.toLowerCase());
          terms.set(term.toLowerCase(), term);
        }
      }
      heard = new Map([...terms].slice(-HEARD_TERMS));
    },
    prompt: () => [...[...heard.values()].reverse(), ...[...known].filter(([key]) => !heard.has(key)).map(([, term]) => term)].slice(0, PROMPT_TERMS).join(', '),
  };
};
