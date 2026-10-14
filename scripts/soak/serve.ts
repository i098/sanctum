/**
 * Results page for the 24-hour soak. Reads the results JSON the checkpoint runner writes and shows
 * each checkpoint against its pass bars. Serves `/` (page) and `/report.json` (results plus
 * verdicts, for agents). Read-only, no product code, no auth: bind it to
 * loopback and expose it with `tailscale serve` (tailnet only, never Funnel).
 *
 * Usage: node scripts/soak/serve.ts --results <results.json> [--port 8460]
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

type Verdict = 'pass' | 'fail' | 'pending';
export interface Checkpoint {
  readonly id: string;
  readonly hour: number;
  readonly at?: string;
  readonly metrics?: Readonly<Record<string, number | null>>;
  readonly facts?: Readonly<Record<string, 'found' | 'wrong' | 'missing'>>;
}
export interface Results {
  readonly run_id?: string;
  readonly started_at?: string;
  readonly status?: 'running' | 'done' | 'stopped';
  readonly stop_reason?: string;
  readonly checkpoints?: ReadonlyArray<Checkpoint>;
  readonly errors?: ReadonlyArray<string>;
}

const HOURS = [1, 5, 12, 24] as const;
/** One bar per checkpoint hour, or one bar for all; `null` means the metric is not judged there. */
interface Bar { readonly key: string; readonly label: string; readonly min?: ReadonlyArray<number | null> | number; readonly max?: ReadonlyArray<number | null> | number }

// Pass bars from the plan board, section 5. Proposals until the 1 h dry run calibrates them.
// ponytail: p95 latency uses the static 1.5 s cap; the plan's "2x the 1 h p95" is not enforced.
const BARS: ReadonlyArray<Bar> = [
  { key: 'recall_at_5', label: 'Recall@5', min: [0.9, 0.85, 0.8, 0.8] },
  { key: 'recall_at_20', label: 'Recall@20', min: [0.95, 0.9, 0.9, 0.9] },
  { key: 'answer_accuracy', label: 'Answer accuracy', min: [0.85, 0.8, 0.8, 0.8] },
  { key: 'range_accuracy', label: 'Time range accuracy', min: 1 },
  { key: 'point_in_time_accuracy', label: 'Point-in-time accuracy', min: [null, 0.8, 0.8, 0.8] },
  { key: 'never_said_not_found', label: 'Never-said control', min: 1 },
  { key: 'latency_p50_s', label: 'Query latency p50 (s)', max: 0.3 },
  { key: 'latency_p95_s', label: 'Query latency p95 (s)', max: [1, 1.5, 1.5, 1.5] },
  { key: 'asr_lag_p95_s', label: 'ASR lag p95 (s)', max: 20 },
  { key: 'asr_lag_max_s', label: 'ASR lag max (s)', max: 60 },
  { key: 'failed_processing', label: 'Failed processing jobs', max: 0 },
  { key: 'db_growth_mb_per_day', label: 'DB growth (MB/day)', max: 100 },
  { key: 'cost_per_hour_usd', label: 'Model cost per hour ($)', max: 0.45 },
  { key: 'cost_total_usd', label: 'Cost so far ($, hard stop 15)', max: 15 },
  { key: 'query_5xx', label: 'Query 5xx', max: 0 },
  { key: 'speech_output_events', label: 'Speech output events', max: 0 },
  { key: 'ghost_finals', label: 'Finals during silent gaps', max: 0 },
];

const at = (bar: ReadonlyArray<number | null> | number | undefined, i: number) => (Array.isArray(bar) ? bar[i] : bar) ?? null;

/** A metric with no value is pending, not failed; a metric with no bar at that hour is judged pass. */
function judge(bar: Bar, value: number | null | undefined, hourIndex: number): Verdict {
  const lo = at(bar.min, hourIndex);
  const hi = at(bar.max, hourIndex);
  if (lo === null && hi === null) return 'pass';
  if (value === null || value === undefined) return 'pending';
  return (lo !== null && value < lo) || (hi !== null && value > hi) ? 'fail' : 'pass';
}

function rowsFor(found: Checkpoint | undefined, i: number) {
  return BARS.map(bar => {
    const value = found?.metrics?.[bar.key] ?? null;
    return { key: bar.key, label: bar.label, value, min: at(bar.min, i), max: at(bar.max, i), verdict: found ? judge(bar, value, i) : 'pending' as Verdict };
  });
}

function summarize(found: Checkpoint | undefined, rows: ReadonlyArray<{ readonly verdict: Verdict }>): Verdict {
  if (!found) return 'pending';
  if (rows.some(r => r.verdict === 'fail')) return 'fail';
  return rows.some(r => r.verdict === 'pending') ? 'pending' : 'pass';
}

export function report(results: Results) {
  const checkpoints = HOURS.map((hour, i) => {
    const found = results.checkpoints?.find(c => c.hour === hour);
    const rows = rowsFor(found, i);
    return { id: found?.id ?? `CP${i + 1}`, hour, at: found?.at ?? null, verdict: summarize(found, rows), rows, facts: found?.facts ?? {} };
  });
  return {
    run_id: results.run_id ?? null,
    started_at: results.started_at ?? null,
    status: results.status ?? 'pending',
    stop_reason: results.stop_reason ?? null,
    errors: results.errors ?? [],
    checkpoints,
  };
}

function load(path: string): Results {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Results; } catch { return {}; }
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sanctum soak</title>
<style>
:root{color-scheme:light dark;font:15px/1.4 system-ui,sans-serif}
body{margin:0 auto;max-width:72rem;padding:1.5rem}
h1{font-size:1.3rem;margin:0 0 .25rem}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem;margin:1rem 0}
.tile{border:1px solid #8886;border-radius:.5rem;padding:.75rem}
.tile b{display:block;font-size:1.1rem}
table{border-collapse:collapse;width:100%;margin:1rem 0}
th,td{border-bottom:1px solid #8884;padding:.3rem .5rem;text-align:right}
th:first-child,td:first-child{text-align:left}
.pass{color:#1a7f37}.fail{color:#cf222e;font-weight:600}.pending{color:#8888}.found{color:#1a7f37}.wrong{color:#cf222e}.missing{color:#bf8700}
small{opacity:.7}
</style>
<h1>Sanctum soak</h1>
<div id="head"></div>
<div class="tiles" id="tiles"></div>
<h2>Metrics against pass bars</h2><table id="metrics"></table>
<h2>Planted facts</h2><table id="facts"></table>
<h2>Errors</h2><ul id="errors"></ul>
<p><small>Data for agents: <a href="report.json">report.json</a>. Refreshes every 30 s.</small></p>
<script>
const el = id => document.getElementById(id);
const make = (tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; };
function row(cells) { const tr = document.createElement('tr'); cells.forEach(c => tr.append(c)); return tr; }
function render(r) {
  el('head').textContent = 'Run ' + (r.run_id ?? '—') + ' · ' + r.status + (r.started_at ? ' · started ' + r.started_at : '') + (r.stop_reason ? ' · stopped: ' + r.stop_reason : '');
  el('tiles').replaceChildren(...r.checkpoints.map(c => { const d = make('div', '', 'tile'); d.append(make('b', c.id + ' · ' + c.hour + ' h'), make('span', c.verdict, c.verdict), make('small', c.at ? ' ' + c.at : '')); return d; }));
  el('metrics').replaceChildren(row([make('th', 'Metric'), ...r.checkpoints.map(c => make('th', c.id))]),
    ...r.checkpoints[0].rows.map((m, i) => row([make('td', m.label), ...r.checkpoints.map(c => { const x = c.rows[i]; const limit = [x.min !== null ? '≥ ' + x.min : '', x.max !== null ? '≤ ' + x.max : ''].filter(Boolean).join(' ') || '—'; return make('td', (x.value ?? '—') + ' (' + limit + ')', x.verdict); })])));
  const ids = [...new Set(r.checkpoints.flatMap(c => Object.keys(c.facts)))];
  el('facts').replaceChildren(row([make('th', 'Fact'), ...r.checkpoints.map(c => make('th', c.id))]),
    ...ids.map(id => row([make('td', id), ...r.checkpoints.map(c => make('td', c.facts[id] ?? '—', c.facts[id]))])));
  el('errors').replaceChildren(...(r.errors.length ? r.errors.map(e => make('li', e)) : [make('li', 'none')]));
}
async function refresh() { try { render(await (await fetch('report.json', { cache: 'no-store' })).json()); } catch (e) { el('head').textContent = 'Cannot read report: ' + e; } }
refresh(); setInterval(refresh, 30000);
</script>`;

if (import.meta.main) {
  const { values } = parseArgs({ options: { results: { type: 'string', default: 'results.json' }, port: { type: 'string', default: '8460' } } });
  const path = values.results;
  createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (url === '/') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE);
    else if (url === '/report.json') res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(report(load(path))));
    else res.writeHead(404).end();
  }).listen(Number(values.port), '127.0.0.1', () => console.log(`soak results on http://127.0.0.1:${values.port}/ from ${path}`));
}
