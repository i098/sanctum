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

const t0 = { epoch_s: T0 / 1000, tz: 'UTC' };
const manifest: Manifest = {
  t0,
  facts: [
    { id: 'L1', at_s: 1200, query: 'launch date', question: 'When is the launch date?', aliases: ['November 3', 'Nov 3'] },
    { id: 'R', at_s: 82_200, query: 'rollout region', question: 'Which region?', aliases: ['eu-west'], latest: true },
    { id: 'LATE', at_s: 3500, query: 'late fact', question: 'late?', aliases: ['x'] },
  ],
  ranges: [{ id: 'D1', query: 'decided', from_s: 14_400, to_s: 36_000, expect: [['pricing']] }],
  controls: [{ id: 'C1', query: 'unicorn budget' }],
};

test('top-k recall counts only matches at the planted time; later same-word items push old facts out', () => {
  const distractors = Array.from({ length: 6 }, (_, i) => item('we should fix the launch date soon', 9000 + i));
  const score = scoreCheckpoint({
    hours: 24, manifest, answers: {
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
    hours: 12, manifest, answers: {
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
    hours: 1, manifest: { t0, facts: [], controls: [{ id: 'C1', query: 'q' }] },
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
  const run = { t0, facts: [manifest.facts[0]!], controls: manifest.controls };
  const score = await runCheckpoint(backend, run, 1);
  assert.deepEqual(score.facts, [{ id: 'L1', keyword: 'found', natural: 'missing' }]);
  assert.equal(score.metrics.control_pass_rate, 1);
  const broken = await runCheckpoint(backend, { t0, facts: [{ ...manifest.facts[0]!, query: 'absent' }] }, 1);
  assert.equal(broken.errors.length, 1);
  assert.equal(broken.metrics.recall_at_5, 0);
});

test('a failed source lookup keeps the returned items: the fact is wrong with a recorded error, not missing', async () => {
  const hit = { text: 'Launch date is Nov 3', event_at: new Date(at(1210)).toISOString(), sources: [{ segment_id: 'gone' }] };
  const backend = fixtureBackend({ search: { 'launch date||': { items: [hit] }, 'When is the launch date?||': { items: [hit] } }, sources: {} });
  const score = await runCheckpoint(backend, { t0, facts: [manifest.facts[0]!] }, 1);
  assert.deepEqual(score.facts, [{ id: 'L1', keyword: 'wrong', natural: 'wrong' }]);
  assert.equal(score.errors.length, 2);
});

test('a weekday_after expectation resolves against T0 and the run time zone; a bare weekday does not match', () => {
  // Fri 2026-10-23 00:30 UTC is still Thu 22 Oct in Los Angeles, so "the Friday after" is 23 Oct there and 30 Oct in UTC.
  const contract = { id: 'C', at_s: 261_000, query: 'contract', question: 'When?', aliases: [], expect: { kind: 'weekday_after', weekday: 'Friday', after_s: 261_000 } } as const;
  const score = (tz: string, text: string) => scoreCheckpoint({
    hours: 73, manifest: { t0: { epoch_s: T0 / 1000, tz }, facts: [contract] },
    answers: { facts: { C: { keyword: answer([item(text, 261_005)]), natural: none } }, ranges: {}, controls: {} },
  }).facts[0]!.keyword;
  assert.equal(score('America/Los_Angeles', 'Dana sends the contract on Friday, Oct 23rd'), 'found');
  assert.equal(score('America/Los_Angeles', 'Dana sends the contract on 2026-10-23'), 'found');
  assert.equal(score('UTC', 'Dana sends the contract on Friday, Oct 23rd'), 'wrong');
  assert.equal(score('UTC', 'Dana sends the contract on October 30'), 'found');
  assert.equal(score('UTC', 'Dana sends the contract on Friday'), 'wrong');
  assert.equal(score('UTC', 'Dana sends the contract on Oct 300'), 'wrong');
});
