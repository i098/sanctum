/**
 * Whisper's `initial_prompt` for one live chunk: the distinct capitalised terms heard in the meeting that owns the
 * chunk, newest first, then, for a principal with `context:read`, the names of the committed items it may read,
 * newest item first. Whisper spells a name it was told about that way again, so "Falcon" said earlier in the meeting
 * and "Asana" from a readable item are heard right. Bounded: a long prompt dilutes each name (measured on the soak
 * clips, docs/DECISIONS.md).
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

/** Terms by lower case, each keeping its first appearance. */
const distinct = (terms: Iterable<string>) => {
  const names = new Map<string, string>();
  for (const term of terms) if (!names.has(term.toLowerCase())) names.set(term.toLowerCase(), term);
  return names;
};

/** `items`: item texts, newest first. */
export const knownNames = (items: Iterable<string>) => distinct([...items].flatMap(properNouns));

/** The newest `HEARD_TERMS` names of `finals`, given newest first; a name said again counts as new. */
export const heardNames = (finals: Iterable<string>) => new Map([...distinct([...finals].flatMap(text => properNouns(text).reverse()))].slice(0, HEARD_TERMS));

export const asrPrompt = (heard: ReadonlyMap<string, string>, known: ReadonlyMap<string, string>) =>
  [...heard.values(), ...[...known].filter(([key]) => !heard.has(key)).map(([, term]) => term)].slice(0, PROMPT_TERMS).join(', ');
