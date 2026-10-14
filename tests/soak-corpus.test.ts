import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FACTS, SAMPLE_RATE, splice, validatePlan } from '../scripts/soak/build-corpus.ts';

test('planted facts and checkpoint questions are consistent', () => {
  assert.deepEqual(validatePlan(), []);
  assert.equal(new Set(FACTS.map(fact => fact.id)).size, FACTS.length);
});

test('relative-date fact C is scored by expect, never by aliases', () => {
  const c = FACTS.find(fact => fact.id === 'C')!;
  assert.deepEqual(c.expect, { kind: 'weekday_after', weekday: 'Friday' });
  assert.deepEqual(c.aliases, []);
  assert.ok(FACTS.filter(fact => fact.id !== 'C').every(fact => fact.expect === undefined && fact.aliases.length > 0));
});

test('splice replaces only the padded clip window and scales the clip', () => {
  const base = new Int16Array(SAMPLE_RATE * 2).fill(1000);
  const clip = Int16Array.from([100, -200, 300]);
  const at = SAMPLE_RATE;
  const pad = Math.round(0.3 * SAMPLE_RATE);
  assert.equal(splice(base, at, clip, 2), at + 3);
  assert.deepEqual([...base.slice(at, at + 3)], [200, -400, 600]);
  assert.equal(base[at - pad], 0);
  assert.equal(base[at + 3 + pad - 1], 0);
  assert.equal(base[at - pad - 1], 1000);
  assert.equal(base[at + 3 + pad], 1000);
  assert.throws(() => splice(base, 10, clip, 1), /does not fit/);
});

test('splice clips instead of wrapping around', () => {
  const base = new Int16Array(SAMPLE_RATE * 2);
  splice(base, SAMPLE_RATE, Int16Array.from([30000, -30000]), 8);
  assert.deepEqual([...base.slice(SAMPLE_RATE, SAMPLE_RATE + 2)], [32767, -32768]);
});
