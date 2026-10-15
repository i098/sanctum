import { describe, expect, it } from 'vitest';
import { asrPrompt, PROMPT_TERMS, properNouns } from '../src/media/asr-hint.ts';

describe('ASR hint', () => {
  it('takes capitalised words inside a sentence, not sentence starts, "I" or run-on fillers', () => {
    expect(properNouns('For the record, the Falcon tickets live in Asana. Sanctum, stop.')).toEqual(['Falcon', 'Asana']);
    expect(properNouns("I'm sure Peter said I would book the Walnut room, But okay, Okay?")).toEqual(['Peter', 'Walnut']);
    expect(properNouns('so we chose "Northwind" Freight.')).toEqual(['Northwind', 'Freight']);
  });

  it('lists item names newest item first, each once in its first spelling, bounded', () => {
    expect(asrPrompt(['We keep the Falcon tickets in Asana.', 'Ask Peter about Falcon and asana.', 'Then Northwind shipped.'])).toBe('Falcon, Asana, Peter, Northwind');
    const many = asrPrompt([`see ${Array.from({ length: PROMPT_TERMS + 5 }, (_, i) => `Name${i}`).join(' ')}`, 'the Late name']);
    expect(many.split(', ')).toEqual(Array.from({ length: PROMPT_TERMS }, (_, i) => `Name${i}`));
  });
});
