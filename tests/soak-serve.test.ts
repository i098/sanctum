import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { barRow, report } from '../scripts/soak/serve.ts';

const metrics = { recall_at_5: 0.95, recall_at_20: 1, natural_recall_at_20: 0.5, answer_accuracy: 0.9, latest_accuracy: 0.9, time_aware_accuracy: 1, control_pass_rate: 1, latency_ms: { p50: 200, p95: 800, samples: 40 } };
const checkpoint = (hours: number, over: Record<string, unknown> = {}) => ({
  asked_at: '2026-10-15T01:00:00.000Z', t0: '2026-10-15T00:00:00.000Z', checkpoint_hours: hours,
  metrics, facts: [{ id: 'L1', keyword: 'found', natural: 'wrong' }], ranges: [], controls: [], errors: [], ...over,
});

function dir(files: Record<string, unknown>) {
  const d = mkdtempSync(join(tmpdir(), 'soak-serve-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), typeof body === 'string' ? body : JSON.stringify(body));
  return d;
}
const verdicts = (d: string) => report(d).checkpoints.map(c => c.verdict);

test('a checkpoint with every bar met passes and checkpoints without a file stay pending', () => {
  const r = report(dir({ 'cp-1h.json': checkpoint(1) }));
  assert.deepEqual(r.checkpoints.map(c => c.verdict), ['pass', 'pending', 'pending', 'pending']);
  assert.equal(r.t0, '2026-10-15T00:00:00.000Z');
  assert.deepEqual(r.checkpoints[0]!.facts, [{ id: 'L1', keyword: 'found', natural: 'wrong' }]);
});

test('a missed bar or a runner error fails the checkpoint; a null metric only leaves it pending', () => {
  const d = dir({
    'cp-1h.json': checkpoint(1, { metrics: { ...metrics, recall_at_5: 0.89 } }),
    'cp-5h.json': checkpoint(5, { errors: ['search 500'] }),
    'cp-12h.json': checkpoint(12, { metrics: { ...metrics, latency_ms: { p50: null, p95: null, samples: 0 } } }),
  });
  assert.deepEqual(verdicts(d), ['fail', 'fail', 'pending', 'pending']);
});

test('bars differ by checkpoint hour', () => {
  const weak = { ...metrics, recall_at_5: 0.82, latency_ms: { p50: 200, p95: 1200, samples: 40 } };
  const d = dir({ 'cp-1h.json': checkpoint(1, { metrics: weak }), 'cp-12h.json': checkpoint(12, { metrics: weak }) });
  assert.deepEqual([verdicts(d)[0], verdicts(d)[2]], ['fail', 'pass']);
});

test('a malformed or unreadable checkpoint file fails that checkpoint without throwing', () => {
  const d = dir({
    'cp-1h.json': 'null',
    'cp-5h.json': '{"checkpoint_hours": 5',
    'cp-12h.json': checkpoint(5),
    'cp-24h.json': checkpoint(24, { metrics: { ...metrics, recall_at_5: 'high' } }),
  });
  const r = report(d);
  assert.deepEqual(r.checkpoints.map(c => c.verdict), ['fail', 'fail', 'fail', 'fail']);
  assert.ok(r.checkpoints.every(c => c.error?.includes('malformed')));
  assert.equal(r.t0, null);
  assert.equal(report(join(d, 'missing-subdir')).checkpoints.every(c => c.verdict === 'pending'), true);
});

test('a pass-bar row is pending without a checkpoint file and judged per hour with one', () => {
  const bar = { label: 'Recall@5', value: (c: { metrics: typeof metrics }) => c.metrics.recall_at_5, min: [0.9, 0.8] };
  const found = checkpoint(1, { metrics: { ...metrics, recall_at_5: 0.85 } }) as never;
  assert.deepEqual(barRow(bar as never, undefined, 0), { label: 'Recall@5', value: null, min: 0.9, max: null, verdict: 'pending' });
  assert.equal(barRow(bar as never, found, 0).verdict, 'fail');
  assert.equal(barRow(bar as never, found, 1).verdict, 'pass');
});
