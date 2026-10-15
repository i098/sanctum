/**
 * Whisper's `initial_prompt` for one live session: the most recent distinct capitalised terms the meeting
 * produced, then the workspace's known names, nearest the audio. Whisper spells a name it was told about
 * that way again, so "Falcon" said earlier and "Asana" from a profile are heard right. Bounded: a long
 * prompt dilutes each name (measured on the soak clips), and Whisper reads only the last 224 prompt tokens.
 */
export const HEARD_TERMS = 15;
export const KNOWN_TERMS = 15;
const TERM_CHARS = 40;
/** Words Whisper capitalises after a comma in run-on speech; they are not names. */
const NOT_NAMES = new Set(['and', 'but', 'so', 'or', 'okay', 'ok', 'yeah', 'yes', 'no', 'oh', 'well', 'um', 'uh', 'the', 'a', 'an', 'it', 'we', 'you', 'they', 'this', 'that', 'what', 'how', 'why']);

/** Capitalised words that do not start a sentence: "Falcon", "Asana", "Sanctum"; never "I" or "I'm". */
export const properNouns = (text: string): Array<string> => {
  const terms: Array<string> = [];
  const words = text.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (/[.!?]["')\]]*$/.test(words[i - 1]!) || !/^\p{Lu}[\p{L}\p{N}'’-]+$/u.test(word) || /^I['’]/.test(word) || NOT_NAMES.has(word.toLowerCase())) continue;
    terms.push(word);
  }
  return terms;
};

/** Up to `limit` distinct terms, case-insensitive; a repeated term moves to the most recent place and the oldest goes first. */
const recentTerms = (limit: number) => {
  const terms = new Map<string, string>();
  return {
    add: (term: string) => {
      const spelled = term.trim();
      if (spelled === '' || spelled.length > TERM_CHARS) return;
      terms.delete(spelled.toLowerCase());
      terms.set(spelled.toLowerCase(), spelled);
      if (terms.size > limit) terms.delete(terms.keys().next().value!);
    },
    terms,
  };
};

/** `known`: the workspace's names, least important first. */
export const asrVocabulary = (known: Iterable<string>) => {
  const names = recentTerms(KNOWN_TERMS);
  for (const name of known) names.add(name);
  const heard = recentTerms(HEARD_TERMS);
  return {
    /** Adds the proper nouns of one final transcript text. */
    heard: (text: string) => properNouns(text).forEach(heard.add),
    prompt: () => [...[...heard.terms.values()].filter(term => !names.terms.has(term.toLowerCase())), ...names.terms.values()].join(', '),
  };
};
