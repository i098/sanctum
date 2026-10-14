/**
 * Results page for the 24-hour soak. Reads the `cp-<H>h.json` files the checkpoint runner
 * (`checkpoint.ts`) writes into one directory and shows each checkpoint against its pass bars.
 * Serves `/` (page) and `/report.json` (checkpoints plus verdicts, for agents). Read-only, no
 * product code, no auth: bind it to loopback and expose it with `tailscale serve` (tailnet only,
 * never Funnel).
 *
 * Usage: node scripts/soak/serve.ts --dir <dir> [--port 8460]
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

type Verdict = 'pass' | 'fail' | 'pending';
type FactStatus = 'found' | 'wrong' | 'missing';
type Metric = number | null;
/** The file `checkpoint.ts` writes: `{ asked_at, t0, ...CheckpointScore }` (scripts/soak/score.ts). */
interface Checkpoint {
  readonly checkpoint_hours: number;
  readonly asked_at: string;
  readonly t0: string;
  readonly metrics: {
    readonly recall_at_5: Metric;
    readonly recall_at_20: Metric;
    readonly natural_recall_at_20: Metric;
    readonly answer_accuracy: Metric;
    readonly latest_accuracy: Metric;
    readonly time_aware_accuracy: Metric;
    readonly control_pass_rate: Metric;
    readonly latency_ms: { readonly p50: Metric; readonly p95: Metric; readonly samples: number };
  };
  readonly facts: ReadonlyArray<{ readonly id: string; readonly keyword: FactStatus; readonly natural: FactStatus }>;
  readonly ranges: ReadonlyArray<unknown>;
  readonly controls: ReadonlyArray<unknown>;
  readonly errors: ReadonlyArray<string>;
}

const HOURS = [1, 5, 12, 24] as const;
type Limit = ReadonlyArray<number | null> | number;
/** One limit per checkpoint hour, or one for all; `null` means the metric is not judged there. */
interface Bar { readonly label: string; readonly value: (c: Checkpoint) => Metric; readonly min?: Limit; readonly max?: Limit }

// Pass bars from the plan board, section 5. Proposals until the 1 h dry run calibrates them.
// ponytail: p95 latency uses the static 1.5 s cap; the plan's "2x the 1 h p95" is not enforced.
const BARS: ReadonlyArray<Bar> = [
  { label: 'Recall@5', value: c => c.metrics.recall_at_5, min: [0.9, 0.85, 0.8, 0.8] },
  { label: 'Recall@20', value: c => c.metrics.recall_at_20, min: [0.95, 0.9, 0.9, 0.9] },
  { label: 'Natural recall@20', value: c => c.metrics.natural_recall_at_20 },
  { label: 'Answer accuracy', value: c => c.metrics.answer_accuracy, min: [0.85, 0.8, 0.8, 0.8] },
  { label: 'Latest accuracy', value: c => c.metrics.latest_accuracy, min: [null, 0.8, 0.8, 0.8] },
  { label: 'Time-aware accuracy', value: c => c.metrics.time_aware_accuracy, min: 1 },
  { label: 'Control pass rate', value: c => c.metrics.control_pass_rate, min: 1 },
  { label: 'Query latency p50 (ms)', value: c => c.metrics.latency_ms.p50, max: 300 },
  { label: 'Query latency p95 (ms)', value: c => c.metrics.latency_ms.p95, max: [1000, 1500, 1500, 1500] },
  { label: 'Errors', value: c => c.errors.length, max: 0 },
];

const at = (limit: Limit | undefined, i: number) => (Array.isArray(limit) ? limit[i] : limit) ?? null;

/** A metric with no value is pending, not failed; a metric with no bar at that hour is judged pass. */
function judge(bar: Bar, value: Metric, hourIndex: number): Verdict {
  const lo = at(bar.min, hourIndex);
  const hi = at(bar.max, hourIndex);
  if (lo === null && hi === null) return 'pass';
  if (value === null) return 'pending';
  return (lo !== null && value < lo) || (hi !== null && value > hi) ? 'fail' : 'pass';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isMetric = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));
const isStatus = (v: unknown) => v === 'found' || v === 'wrong' || v === 'missing';
const isFact = (f: unknown) => isObject(f) && typeof f.id === 'string' && isStatus(f.keyword) && isStatus(f.natural);
const SCORE_KEYS = ['recall_at_5', 'recall_at_20', 'natural_recall_at_20', 'answer_accuracy', 'latest_accuracy', 'time_aware_accuracy', 'control_pass_rate'];

/** Each rule returns the reason `raw` is not a runner checkpoint for `hours`, or null. */
const RULES: ReadonlyArray<(raw: Record<string, unknown>, hours: number) => string | null> = [
  (raw, hours) => (raw.checkpoint_hours === hours ? null : `checkpoint_hours is ${String(raw.checkpoint_hours)}, expected ${hours}`),
  raw => (typeof raw.asked_at === 'string' && typeof raw.t0 === 'string' ? null : 'asked_at and t0 must be strings'),
  raw => (isObject(raw.metrics) && isObject(raw.metrics.latency_ms) ? null : 'metrics.latency_ms is missing'),
  raw => {
    const metrics = raw.metrics as Record<string, unknown>;
    const latency = metrics.latency_ms as Record<string, unknown>;
    return [...SCORE_KEYS.map(k => metrics[k]), latency.p50, latency.p95].every(isMetric) ? null : 'metrics must be numbers or null';
  },
  raw => (Array.isArray(raw.facts) && raw.facts.every(isFact) ? null : 'facts must be {id, keyword, natural} rows'),
  raw => (Array.isArray(raw.ranges) && Array.isArray(raw.controls) ? null : 'ranges and controls must be arrays'),
  raw => (Array.isArray(raw.errors) && raw.errors.every(e => typeof e === 'string') ? null : 'errors must be strings'),
];

function parse(raw: unknown, hours: number): Checkpoint {
  if (!isObject(raw)) throw new Error('not a JSON object');
  for (const rule of RULES) {
    const reason = rule(raw, hours);
    if (reason) throw new Error(reason);
  }
  return raw as unknown as Checkpoint;
}

type Loaded = { readonly found: Checkpoint } | { readonly error: string } | null;

/** null: no file yet (pending). error: unreadable or malformed file (fail). */
function load(dir: string, hours: number): Loaded {
  let text: string;
  try { text = readFileSync(join(dir, `cp-${hours}h.json`), 'utf8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : { error: `cannot read cp-${hours}h.json: ${(e as Error).message}` };
  }
  try { return { found: parse(JSON.parse(text), hours) }; } catch (e) { return { error: `cp-${hours}h.json is malformed: ${(e as Error).message}` }; }
}

function verdictOf(loaded: Loaded, rows: ReadonlyArray<{ readonly verdict: Verdict }>): Verdict {
  if (loaded === null) return 'pending';
  if ('error' in loaded || rows.some(r => r.verdict === 'fail')) return 'fail';
  return rows.some(r => r.verdict === 'pending') ? 'pending' : 'pass';
}

const NO_FILE = { asked_at: null, facts: [], ranges: [], controls: [], errors: [] };

/** One pass-bar row; without a checkpoint file every row is pending. */
export function barRow(bar: Bar, found: Checkpoint | undefined, hourIndex: number) {
  const value = found ? bar.value(found) : null;
  const verdict: Verdict = found ? judge(bar, value, hourIndex) : 'pending';
  return { label: bar.label, value, min: at(bar.min, hourIndex), max: at(bar.max, hourIndex), verdict };
}

function checkpointReport(hour: number, i: number, loaded: Loaded) {
  const found = loaded && 'found' in loaded ? loaded.found : undefined;
  const rows = BARS.map(bar => barRow(bar, found, i));
  const { asked_at, facts, ranges, controls, errors } = found ?? NO_FILE;
  return { hour, rows, verdict: verdictOf(loaded, rows), asked_at, error: loaded && 'error' in loaded ? loaded.error : null, facts, ranges, controls, errors };
}

export function report(dir: string) {
  const loaded = HOURS.map(hour => load(dir, hour));
  const first = loaded.find(l => l !== null && 'found' in l);
  return {
    t0: first && 'found' in first ? first.found.t0 : null,
    checkpoints: HOURS.map((hour, i) => checkpointReport(hour, i, loaded[i]!)),
  };
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
  el('head').textContent = 'Run start (t0) ' + (r.t0 ?? '—');
  el('tiles').replaceChildren(...r.checkpoints.map(c => { const d = make('div', '', 'tile'); d.append(make('b', c.hour + ' h'), make('span', c.verdict, c.verdict), make('small', c.asked_at ? ' asked ' + c.asked_at : ''), make('small', c.error ? ' ' + c.error : '')); return d; }));
  el('metrics').replaceChildren(row([make('th', 'Metric'), ...r.checkpoints.map(c => make('th', c.hour + ' h'))]),
    ...r.checkpoints[0].rows.map((m, i) => row([make('td', m.label), ...r.checkpoints.map(c => { const x = c.rows[i]; const limit = [x.min !== null ? '≥ ' + x.min : '', x.max !== null ? '≤ ' + x.max : ''].filter(Boolean).join(' ') || '—'; return make('td', (x.value ?? '—') + ' (' + limit + ')', x.verdict); })])));
  const ids = [...new Set(r.checkpoints.flatMap(c => c.facts.map(f => f.id)))];
  const cell = (c, id) => { const f = c.facts.find(x => x.id === id); return f ? make('td', f.keyword + ' / ' + f.natural, f.keyword) : make('td', '—'); };
  el('facts').replaceChildren(row([make('th', 'Fact (keyword / natural)'), ...r.checkpoints.map(c => make('th', c.hour + ' h'))]),
    ...ids.map(id => row([make('td', id), ...r.checkpoints.map(c => cell(c, id))])));
  const errors = r.checkpoints.flatMap(c => [...(c.error ? [c.error] : []), ...c.errors].map(e => c.hour + ' h: ' + e));
  el('errors').replaceChildren(...(errors.length ? errors.map(e => make('li', e)) : [make('li', 'none')]));
}
async function refresh() { try { render(await (await fetch('report.json', { cache: 'no-store' })).json()); } catch (e) { el('head').textContent = 'Cannot read report: ' + e; } }
refresh(); setInterval(refresh, 30000);
</script>`;

if (import.meta.main) {
  const { values } = parseArgs({ options: { dir: { type: 'string', default: '.' }, port: { type: 'string', default: '8460' } } });
  const dir = values.dir;
  createServer((req, res) => {
    try {
      const url = (req.url ?? '/').split('?')[0];
      if (req.method !== 'GET') res.writeHead(405).end();
      else if (url === '/') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE);
      else if (url === '/report.json') res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(report(dir)));
      else res.writeHead(404).end();
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }).listen(Number(values.port), '127.0.0.1', () => console.log(`soak results on http://127.0.0.1:${values.port}/ from ${dir}`));
}
