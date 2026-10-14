import assert from 'node:assert/strict';
import { test } from 'node:test';
import { percentile, scoreCheckpoint } from '../scripts/soak/score.ts';
import type { Answer, Item, Manifest } from '../scripts/soak/score.ts';
import { fixtureBackend, runCheckpoint } from '../scripts/soak/checkpoint.ts';

const T0 = Date.parse('2026-10-20T00:00:00.000Z');
const at = (seconds: number) => T0 + seconds * 1000;
const item = (text: string, seconds: number): Item => ({ text, event_at: new Date(at(seconds)).toISOString(), source_ms: [at(seconds)] });
const answer = (items: Item[], ms = 100): Answer => ({ items, ms });
const none = answer([], 50);

const manifest: Manifest = {
  facts: [
    { id: 'L1', at_s: 1200, query: 'launch date', question: 'When is the launch date?', answers: ['November 3', 'Nov 3'] },
    { id: 'R', at_s: 82_200, query: 'rollout region', question: 'Which region?', answers: ['eu-west'], latest: true },
    { id: 'LATE', at_s: 3500, query: 'late fact', question: 'late?', answers: ['x'] },
  ],
  ranges: [{ id: 'D1', query: 'decided', from_s: 14_400, to_s: 36_000, expect: [['pricing']] }],
  controls: [{ id: 'C1', query: 'unicorn budget' }],
};

test('top-k recall counts only matches at the planted time; later same-word items push old facts out', () => {
  const distractors = Array.from({ length: 6 }, (_, i) => item('we should fix the launch date soon', 9000 + i));
  const score = scoreCheckpoint({
    hours: 24, manifest, t0_ms: T0, answers: {
      facts: {
        L1: { keyword: answer([...distractors, item('The launch date is Nov 3.', 1210)]), natural: none },
        R: { keyword: answer([item('Rollout region is eu-west', 82_200), item('rollout region eu-central', 40_000)]), natural: none },
        LATE: { keyword: none, natural: none },
      },
      ranges: { D1: answer([item('Pricing decided: $48k', 20_000)]) },
      controls: { C1: none },
    },
  });
  // All three facts are old enough at 24 h; LATE was never extracted.
  assert.equal(score.metrics.recall_at_5, 1 / 3);
  assert.equal(score.metrics.recall_at_20, 2 / 3);
  assert.equal(score.metrics.latest_accuracy, 1);
  assert.equal(score.metrics.time_aware_accuracy, 1);
  assert.equal(score.metrics.control_pass_rate, 1);
  assert.deepEqual(score.facts.map(f => f.keyword), ['found', 'found', 'missing']);
});

test('a right answer cited from the wrong moment is wrong, an out-of-window range item fails, a control hit fails', () => {
  const score = scoreCheckpoint({
    hours: 12, manifest, t0_ms: T0, answers: {
      facts: { L1: { keyword: answer([item('launch date November 3 is a draft', 9000)]), natural: answer([item('The launch date is Nov 3', 1200)]) }, LATE: { keyword: none, natural: none } },
      ranges: { D1: answer([item('Pricing decided', 20_000), item('Pricing decided earlier', 100)]) },
      controls: { C1: answer([item('unicorn budget approved', 10)]) },
    },
  });
  assert.deepEqual(score.facts, [{ id: 'L1', keyword: 'wrong', natural: 'found' }, { id: 'LATE', keyword: 'missing', natural: 'missing' }]);
  assert.equal(score.metrics.answer_accuracy, 0.5);
  assert.equal(score.metrics.time_aware_accuracy, 0);
  assert.equal(score.metrics.control_pass_rate, 0);
});

test('nearest-rank percentiles and an error answer is counted, not scored as correct', () => {
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.5), 50);
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95), 100);
  assert.equal(percentile([], 0.5), null);
  const score = scoreCheckpoint({
    hours: 1, manifest: { facts: [], controls: [{ id: 'C1', query: 'q' }] }, t0_ms: T0,
    answers: { facts: {}, ranges: {}, controls: { C1: { items: [], ms: 5, error: 'q: HTTP 503' } } },
  });
  assert.equal(score.metrics.control_pass_rate, 0);
  assert.deepEqual(score.errors, ['q: HTTP 503']);
});

test('the runner asks every due question, resolves cited segments for matching items, and keeps a failed call as an error', async () => {
  const hit = { text: 'Launch date is Nov 3', event_at: new Date(at(1210)).toISOString(), sources: [{ segment_id: 's1' }] };
  const backend = fixtureBackend({
    search: { 'launch date||': { items: [hit] }, 'When is the launch date?||': { items: [] }, 'unicorn budget||': { items: [] } },
    sources: { s1: { kind: 'segment', event_at: new Date(at(1205)).toISOString() } },
  });
  const run = { facts: [manifest.facts[0]!], controls: manifest.controls };
  const score = await runCheckpoint(backend, run, 1, T0);
  assert.deepEqual(score.facts, [{ id: 'L1', keyword: 'found', natural: 'missing' }]);
  assert.equal(score.metrics.control_pass_rate, 1);
  const broken = await runCheckpoint(backend, { facts: [{ ...manifest.facts[0]!, query: 'absent' }] }, 1, T0);
  assert.equal(broken.errors.length, 1);
  assert.equal(broken.metrics.recall_at_5, 0);
});
