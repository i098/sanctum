import { describe, expect, it } from 'vitest';
import { asrPrompt, HEARD_TERMS, heardNames, knownNames, PROMPT_TERMS, properNouns } from '../src/media/asr-hint.ts';

describe('ASR hint', () => {
  it('takes capitalised words inside a sentence, not sentence starts, "I" or run-on fillers', () => {
    expect(properNouns('For the record, the Falcon tickets live in Asana. Sanctum, stop.')).toEqual(['Falcon', 'Asana']);
    expect(properNouns("I'm sure Peter said I would book the Walnut room, But okay, Okay?")).toEqual(['Peter', 'Walnut']);
    expect(properNouns('so we chose "Northwind" Freight.')).toEqual(['Northwind', 'Freight']);
  });

  it('puts heard names first, newest first, then item names, newest item first, each once', () => {
    const known = knownNames(['We keep the Falcon tickets in Asana.', 'Ask Peter about Falcon and asana.', 'Then Northwind shipped.']);
    expect(asrPrompt(new Map(), known)).toBe('Falcon, Asana, Peter, Northwind');
    const heard = heardNames(['back to Falcon', 'then the Falcon met PETER and Dublin']);
    expect(asrPrompt(heard, known)).toBe('Falcon, Dublin, PETER, Asana, Northwind');
  });

  it('keeps the newest heard names and bounds the whole prompt', () => {
    const known = knownNames([`see ${Array.from({ length: PROMPT_TERMS }, (_, i) => `Known${i}`).join(' ')}`]);
    expect(asrPrompt(new Map(), known).split(', ')).toHaveLength(PROMPT_TERMS);
    const heard = heardNames([`we said ${Array.from({ length: HEARD_TERMS + 1 }, (_, i) => `Name${i}`).join(' ')}`]);
    expect(asrPrompt(heard, known).split(', ')).toEqual([
      ...Array.from({ length: HEARD_TERMS }, (_, i) => `Name${HEARD_TERMS - i}`),
      ...Array.from({ length: PROMPT_TERMS - HEARD_TERMS }, (_, i) => `Known${i}`),
    ]);
  });
});
