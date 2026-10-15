import assert from 'node:assert/strict';
import { test } from 'node:test';
import { percentile, scoreCheckpoint } from '../scripts/soak/score.ts';
import type { Answer, Fact, Item, Manifest, Question, QuestionAnswers } from '../scripts/soak/score.ts';
import { fixtureBackend, runCheckpoint } from '../scripts/soak/checkpoint.ts';

const T0 = Date.parse('2026-10-20T00:00:00.000Z');
const at = (seconds: number) => T0 + seconds * 1000;
const iso = (seconds: number) => new Date(at(seconds)).toISOString();
const item = (text: string, seconds: number): Item => ({ text, event_at: iso(seconds), source_ms: [at(seconds)] });
const answer = (items: Item[], ms = 100): Answer => ({ items, ms });
const none = answer([], 50);
const qa = (keyword: Answer, natural: Answer = none): QuestionAnswers => ({ keyword, natural });

const t0 = { epoch_s: T0 / 1000, tz: 'UTC' };
const facts: Fact[] = [
  { id: 'L1', at_s: 600, aliases: ['Nov 3', 'November 3'] },
  { id: 'L2', at_s: 14_700, aliases: ['Nov 17'] },
  { id: 'L3', at_s: 50_000, aliases: ['Dec 1'] },
  { id: 'C', at_s: 261_000, aliases: [], expect: { kind: 'weekday_after', weekday: 'Friday', after_s: 261_000 } },
];
const question = (id: string, mode: Question['mode'], keywords: string | null, expect: string[], extra: Partial<Question> = {}): Question => ({ id, question: `${id}?`, keywords, mode, expect, ...extra });
const manifestOf = (...checkpoints: Array<[hours: number, ...questions: Question[]]>): Manifest => ({
  t0, alias_match: 'whole_token', facts,
  checkpoints: checkpoints.map(([hours, ...questions]) => ({ id: `cp${hours}`, at_s: hours * 3600, questions })),
});
const answersOf = (rows: Record<string, QuestionAnswers>) => rows;

test('recall counts the top k newest-first; a newer same-word item beats the expected one for latest-wins', () => {
  const manifest = manifestOf([5, question('cur', 'current', 'launch', ['L2']), question('asof', 'as_of', 'launch', ['L1'], { as_of_s: 14_400 })]);
  const distractors = Array.from({ length: 6 }, (_, i) => item('we should fix the launch date soon', 16_000 + i));
  const score = scoreCheckpoint({
    hours: 5, manifest, answers: answersOf({
      cur: qa(answer([...distractors, item('Launch moved to Nov 17', 14_710)])),
      asof: qa(answer([item('Launch is Nov 3', 610)])),
    }),
  });
  assert.equal(score.metrics.recall_at_5, 0.5);
  assert.equal(score.metrics.recall_at_20, 1);
  assert.equal(score.metrics.latest_accuracy, 0);
  assert.equal(score.metrics.time_aware_accuracy, 1);
  assert.deepEqual(score.facts, [{ id: 'L2', keyword: 'found', natural: 'missing' }, { id: 'L1', keyword: 'found', natural: 'missing' }]);
});

test('an as_of answer is wrong when an item falls at or after the window end', () => {
  const manifest = manifestOf([5, question('asof', 'as_of', 'launch', ['L1'], { as_of_s: 14_400 })]);
  const score = (items: Item[]) => scoreCheckpoint({ hours: 5, manifest, answers: answersOf({ asof: qa(answer(items)) }) }).metrics.time_aware_accuracy;
  assert.equal(score([item('Launch is Nov 3', 610)]), 1);
  assert.equal(score([item('Launch is Nov 17', 14_400), item('Launch is Nov 3', 610)]), 0);
});

test('history must read in time order, range must stay inside its window, and a control hit fails', () => {
  const manifest = manifestOf([24,
    question('hist', 'history', 'launch', ['L1', 'L2', 'L3']),
    question('rng', 'range', null, ['L2'], { range_s: [14_400, 36_000] }),
    question('ctl', 'never_said', 'audit approved', []),
  ]);
  const l1 = item('Launch Nov 3', 610);
  const l2 = item('Launch Nov 17', 14_710);
  const l3 = item('Launch Dec 1', 50_010);
  const good = scoreCheckpoint({
    hours: 24, manifest, answers: answersOf({ hist: qa(answer([l3, l2, l1])), rng: qa(answer([l2, item('other', 20_000)])), ctl: qa(none) }),
  });
  assert.equal(good.metrics.time_aware_accuracy, 1);
  assert.equal(good.metrics.control_pass_rate, 1);
  const bad = scoreCheckpoint({
    hours: 24, manifest, answers: answersOf({
      hist: qa(answer([l3, { ...l2, event_at: iso(100) }, l1])),
      rng: qa(answer([l2, item('other', 40_000)])),
      ctl: qa(answer([item('audit approved by Dana', 5)])),
    }),
  });
  assert.deepEqual(bad.ranges, [{ id: 'hist', correct: false }, { id: 'rng', correct: false }]);
  assert.equal(bad.metrics.control_pass_rate, 0);
});

test('nearest-rank percentiles; an error answer is counted and never scores as a pass', () => {
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.5), 50);
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95), 100);
  assert.equal(percentile([], 0.5), null);
  const score = scoreCheckpoint({
    hours: 1, manifest: manifestOf([1, question('ctl', 'never_said', 'audit approved', [])]),
    answers: answersOf({ ctl: qa({ items: [], ms: 5, error: 'q: HTTP 503' }) }),
  });
  assert.equal(score.metrics.control_pass_rate, 0);
  assert.deepEqual(score.errors, ['q: HTTP 503']);
});

test('the runner passes each question its window, resolves cited segments, and keeps a failed lookup as an error', async () => {
  const manifest = manifestOf(
    [1, question('cur', 'current', 'launch', ['L1']), question('ctl', 'never_said', 'unicorn', [])],
    [5, question('asof', 'as_of', 'launch', ['L1'], { as_of_s: 14_400 })],
    [12, question('rng', 'range', null, ['L2'], { range_s: [14_400, 36_000] })],
  );
  const l1 = { text: 'Launch is Nov 3', event_at: iso(610), sources: [{ segment_id: 's1' }] };
  const l2 = { text: 'Launch is Nov 17', event_at: iso(14_710), sources: [{ segment_id: 's2' }] };
  const sources = { s1: { kind: 'segment', event_at: iso(605) }, s2: { kind: 'segment', event_at: iso(14_705) } };
  const backend = fixtureBackend({
    search: {
      'launch||': { items: [l1] }, 'cur?||': { items: [] }, 'unicorn||': { items: [] }, 'ctl?||': { items: [] },
      [`launch||${iso(14_400)}`]: { items: [l1] }, [`asof?||${iso(14_400)}`]: { items: [] },
      [`|${iso(14_400)}|${iso(36_000)}`]: { items: [l2] }, [`rng?|${iso(14_400)}|${iso(36_000)}`]: { items: [] },
    },
    sources,
  });
  const first = await runCheckpoint(backend, manifest, 1);
  assert.deepEqual(first.facts, [{ id: 'L1', keyword: 'found', natural: 'missing' }]);
  assert.equal(first.metrics.control_pass_rate, 1);
  assert.equal((await runCheckpoint(backend, manifest, 5)).metrics.time_aware_accuracy, 1);
  assert.equal((await runCheckpoint(backend, manifest, 12)).metrics.time_aware_accuracy, 1);
  const noSources = fixtureBackend({ search: { 'launch||': { items: [l1] }, 'cur?||': { items: [l1] } }, sources: {} });
  const broken = await runCheckpoint(noSources, manifestOf([1, question('cur', 'current', 'launch', ['L1'])]), 1);
  assert.deepEqual(broken.facts, [{ id: 'L1', keyword: 'wrong', natural: 'wrong' }]);
  assert.equal(broken.errors.length, 2);
});

test('a weekday_after expectation resolves against the real play time and the run time zone; a bare weekday does not match', () => {
  // Fri 2026-10-23 00:30 UTC is still Thu 22 Oct in Los Angeles, so "the Friday after" is 23 Oct there and 30 Oct in UTC.
  const manifest = (tz: string): Manifest => ({ ...manifestOf([73, question('cur', 'current', 'contract', ['C'])]), t0: { epoch_s: T0 / 1000, tz } });
  const score = (tz: string, text: string) => scoreCheckpoint({
    hours: 73, manifest: manifest(tz), answers: answersOf({ cur: qa(answer([item(text, 261_005)])) }),
  }).facts[0]!.keyword;
  assert.equal(score('America/Los_Angeles', 'Dana sends the contract on Friday, Oct 23rd'), 'found');
  assert.equal(score('America/Los_Angeles', 'Dana sends the contract on 2026-10-23'), 'found');
  assert.equal(score('UTC', 'Dana sends the contract on Friday, Oct 23rd'), 'wrong');
  assert.equal(score('UTC', 'Dana sends the contract on October 30'), 'found');
  assert.equal(score('UTC', 'Dana sends the contract on Friday'), 'wrong');
  assert.equal(score('UTC', 'Dana sends the contract on Oct 300'), 'wrong');
});

test('a fact the driver played late is matched at its actual_at, and falls back to T0 + at_s without one', () => {
  const run = (actual_at: string | undefined, cited_s: number) => scoreCheckpoint({
    hours: 5, manifest: { ...manifestOf([5, question('cur', 'current', 'launch', ['L1'])]), facts: [{ ...facts[0]!, ...(actual_at && { actual_at }) }] },
    answers: answersOf({ cur: qa(answer([item('Launch is Nov 3', cited_s)])) }),
  }).facts[0]!.keyword;
  assert.equal(run(iso(4200), 4200), 'found');
  assert.equal(run(iso(4200), 600), 'wrong');
  assert.equal(run(undefined, 600), 'found');
  assert.throws(() => run('later', 600), /not a timestamp/);
});
