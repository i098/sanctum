import { describe, expect, it } from 'vitest';
import { asrVocabulary, HEARD_TERMS, KNOWN_TERMS, properNouns } from '../src/media/asr-hint.ts';

describe('ASR hint', () => {
  it('takes capitalised words inside a sentence, not sentence starts, "I" or run-on fillers', () => {
    expect(properNouns('For the record, the Falcon tickets live in Asana. Sanctum, stop.')).toEqual(['Falcon', 'Asana']);
    expect(properNouns("I'm sure Peter said I would book the Walnut room, But okay, Okay?")).toEqual(['Peter', 'Walnut']);
    expect(properNouns('so we chose "Northwind" Freight.')).toEqual(['Northwind', 'Freight']);
  });

  it('puts the most recent heard terms first and the known names last, each bounded', () => {
    const vocabulary = asrVocabulary(['Peter Smith', 'x'.repeat(41), ...Array.from({ length: KNOWN_TERMS }, (_, i) => `Known${i}`)]);
    expect(vocabulary.prompt().split(', ')).toEqual(Array.from({ length: KNOWN_TERMS }, (_, i) => `Known${i}`));
    vocabulary.heard('then the falcon and the Falcon met Known3 and FALCON');
    expect(vocabulary.prompt().split(', ').slice(0, 2)).toEqual(['FALCON', 'Known0']);
    vocabulary.heard(`we said ${Array.from({ length: HEARD_TERMS + 1 }, (_, i) => `Name${i}`).join(' ')}`);
    const terms = vocabulary.prompt().split(', ');
    expect(terms).toHaveLength(HEARD_TERMS + KNOWN_TERMS);
    expect(terms.slice(0, 2)).toEqual(['Name1', 'Name2']);
    expect(terms.at(-1)).toBe(`Known${KNOWN_TERMS - 1}`);
  });
});
