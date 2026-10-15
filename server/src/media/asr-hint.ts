/**
 * Whisper's `initial_prompt` for live chunks: the capitalised names of the newest current committed items the capturing
 * principal may read (`context:read` and `searchContext` visibility), newest item first, each name once. Whisper spells a
 * name it was told about that way again. A name said in the meeting helps only once extraction has committed an item
 * naming it. Bounded: a long prompt dilutes each name (measured on the soak clips, docs/DECISIONS.md).
 */
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

/** `items`: item texts, newest first. The first `PROMPT_TERMS` distinct names, case-insensitive, each in its first spelling. */
export const asrPrompt = (items: Iterable<string>) => {
  const names = new Map<string, string>();
  for (const text of items) {
    for (const term of properNouns(text)) if (!names.has(term.toLowerCase())) names.set(term.toLowerCase(), term);
    if (names.size >= PROMPT_TERMS) break;
  }
  return [...names.values()].slice(0, PROMPT_TERMS).join(', ');
};
