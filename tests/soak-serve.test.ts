import assert from 'node:assert/strict';
import { test } from 'node:test';
import { report } from '../scripts/soak/serve.ts';

const good = { recall_at_5: 0.95, recall_at_20: 1, answer_accuracy: 0.9, range_accuracy: 1, never_said_not_found: 1, latency_p50_s: 0.2, latency_p95_s: 0.8, asr_lag_p95_s: 10, asr_lag_max_s: 30, failed_processing: 0, db_growth_mb_per_day: 20, cost_per_hour_usd: 0.2, cost_total_usd: 0.3, query_5xx: 0, speech_output_events: 0, ghost_finals: 0 };

test('a checkpoint with every bar met passes and later checkpoints stay pending', () => {
  const r = report({ checkpoints: [{ id: 'CP1', hour: 1, metrics: good }] });
  assert.deepEqual(r.checkpoints.map(c => c.verdict), ['pass', 'pending', 'pending', 'pending']);
});

test('one missed bar fails the checkpoint and a missing metric only leaves it pending', () => {
  const r = report({ checkpoints: [
    { id: 'CP1', hour: 1, metrics: { ...good, recall_at_5: 0.89 } },
    { id: 'CP2', hour: 5, metrics: { ...good, point_in_time_accuracy: 0.8, speech_output_events: 1 } },
    { id: 'CP3', hour: 12, metrics: { ...good, point_in_time_accuracy: 0.8, latency_p95_s: undefined as never } },
  ] });
  assert.deepEqual(r.checkpoints.map(c => c.verdict), ['fail', 'fail', 'pending', 'pending']);
});

test('bars differ by checkpoint hour', () => {
  const metrics = { ...good, recall_at_5: 0.82, point_in_time_accuracy: 0.9 };
  const r = report({ checkpoints: [{ id: 'CP1', hour: 1, metrics }, { id: 'CP3', hour: 12, metrics }] });
  assert.deepEqual([r.checkpoints[0]!.verdict, r.checkpoints[2]!.verdict], ['fail', 'pass']);
});
