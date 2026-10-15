/**
 * Whisper's `initial_prompt` for one live session: the most recent distinct capitalised terms the meeting
 * produced, then the names the workspace's committed items use most, nearest the audio. Whisper spells a
 * name it was told about that way again, so "Falcon" said earlier and "Asana" from an earlier meeting's
 * items are heard right. Bounded: a long prompt dilutes each name (measured on the soak clips), and
 * Whisper reads only the last 224 prompt tokens.
 */
export const HEARD_TERMS = 15;
export const KNOWN_TERMS = 30;
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

/** Up to `limit` distinct terms, case-insensitive; a repeated term moves to the most recent place and the oldest goes first. */
const recentTerms = (limit: number) => {
  const terms = new Map<string, string>();
  return {
    add: (term: string) => {
      terms.delete(term.toLowerCase());
      terms.set(term.toLowerCase(), term);
      if (terms.size > limit) terms.delete(terms.keys().next().value!);
    },
    terms,
  };
};

/**
 * The `KNOWN_TERMS` proper nouns named by the most items, least first; a tie goes to the newer item.
 * `items`: item texts, newest first. A name counts once per item, so one long item does not crowd out the rest.
 */
const knownNames = (items: Iterable<string>) => {
  const counts = new Map<string, { term: string; items: number }>();
  for (const text of items) {
    const named = new Set<string>();
    for (const term of properNouns(text)) {
      const key = term.toLowerCase();
      if (named.has(key)) continue;
      named.add(key);
      const known = counts.get(key);
      if (known) known.items++;
      else counts.set(key, { term, items: 1 });
    }
  }
  return new Map([...counts].sort(([, a], [, b]) => b.items - a.items).slice(0, KNOWN_TERMS).reverse().map(([key, { term }]) => [key, term]));
};

/** `items`: the texts of the workspace's committed items, newest first. */
export const asrVocabulary = (items: Iterable<string>) => {
  const names = knownNames(items);
  const heard = recentTerms(HEARD_TERMS);
  return {
    /** Adds the proper nouns of one final transcript text. */
    heard: (text: string) => properNouns(text).forEach(heard.add),
    prompt: () => [...[...heard.terms.values()].filter(term => !names.has(term.toLowerCase())), ...names.values()].join(', '),
  };
};
