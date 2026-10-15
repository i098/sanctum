import { describe, expect, it } from 'vitest';
import { asrVocabulary, HEARD_TERMS, PROMPT_TERMS, properNouns } from '../src/media/asr-hint.ts';

describe('ASR hint', () => {
  it('takes capitalised words inside a sentence, not sentence starts, "I" or run-on fillers', () => {
    expect(properNouns('For the record, the Falcon tickets live in Asana. Sanctum, stop.')).toEqual(['Falcon', 'Asana']);
    expect(properNouns("I'm sure Peter said I would book the Walnut room, But okay, Okay?")).toEqual(['Peter', 'Walnut']);
    expect(properNouns('so we chose "Northwind" Freight.')).toEqual(['Northwind', 'Freight']);
  });

  it('puts heard names first, newest first, then item names, newest item first, each once', () => {
    const vocabulary = asrVocabulary(['We keep the Falcon tickets in Asana.', 'Ask Peter about Falcon and asana.', 'Then Northwind shipped.']);
    expect(vocabulary.prompt()).toBe('Falcon, Asana, Peter, Northwind');
    vocabulary.hear(['then the Falcon met PETER and Dublin', 'back to Falcon']);
    expect(vocabulary.prompt()).toBe('Falcon, Dublin, PETER, Asana, Northwind');
  });

  it('replaces the heard names with those of the current meeting', () => {
    const vocabulary = asrVocabulary([]);
    vocabulary.hear(['the codename is Bluebird']);
    vocabulary.hear(['the Walnut room is booked']);
    expect(vocabulary.prompt()).toBe('Walnut');
    vocabulary.hear([]);
    expect(vocabulary.prompt()).toBe('');
  });

  it('keeps the newest heard names and bounds the whole prompt', () => {
    const vocabulary = asrVocabulary([`see ${Array.from({ length: PROMPT_TERMS }, (_, i) => `Known${i}`).join(' ')}`]);
    expect(vocabulary.prompt().split(', ')).toHaveLength(PROMPT_TERMS);
    vocabulary.hear([`we said ${Array.from({ length: HEARD_TERMS + 1 }, (_, i) => `Name${i}`).join(' ')}`]);
    expect(vocabulary.prompt().split(', ')).toEqual([
      ...Array.from({ length: HEARD_TERMS }, (_, i) => `Name${HEARD_TERMS - i}`),
      ...Array.from({ length: PROMPT_TERMS - HEARD_TERMS }, (_, i) => `Known${i}`),
    ]);
  });
});
