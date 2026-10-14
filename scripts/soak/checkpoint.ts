/**
 * Soak retrieval checkpoint: asks the planted questions through `GET /api/v1/context/search`
 * (keyword form, natural-language form, time-range form, never-said controls), resolves the cited
 * segments of matching items through `GET /api/v1/sources/{id}`, scores the answers and writes JSON.
 * It only reads; it never records, writes context or calls a paid model.
 *
 * Usage: node scripts/soak/checkpoint.ts --manifest manifest.json --hours 1|5|12|24 --out cp-1h.json
 *          (--url https://sanctum.example [--token-env SANCTUM_SOAK_TOKEN] | --fixture search-fixture.json) --t0 ISO
 *
 * Time-range questions use the `from`/`to` search parameters added with the search-range change; until
 * the hosted app serves them, run against a fixture of that response shape:
 *   { "search": { "<q>|<from>|<to>": { "items": [ContextItem...] } }, "sources": { "<segment_id>": Source } }
 * with empty `from`/`to` for unranged queries.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { askable, matches, scoreCheckpoint } from './score.ts';
import type { Answer, Fact, Item, Manifest } from './score.ts';

const LIMIT = 20;
const CHECKPOINT_HOURS = ['1', '5', '12', '24'];

interface ApiItem { readonly text: string; readonly event_at: string | null; readonly sources: ReadonlyArray<{ readonly segment_id?: string }> }
interface ApiSource { readonly kind: string; readonly event_at?: string }
interface Fixture { readonly search: Readonly<Record<string, { readonly items: ReadonlyArray<ApiItem> }>>; readonly sources: Readonly<Record<string, ApiSource>> }

/** Where answers come from: the hosted API or a recorded fixture. */
interface Backend {
  search(q: string, range: { readonly from?: string; readonly to?: string }): Promise<ReadonlyArray<ApiItem>>;
  source(segmentId: string): Promise<ApiSource>;
}

function httpBackend(url: string, token: string): Backend {
  const get = async <T>(path: string, params: URLSearchParams = new URLSearchParams()): Promise<T> => {
    const response = await fetch(`${url.replace(/\/$/, '')}/api/v1${path}?${params}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    search: async (q, { from, to }) => {
      const params = new URLSearchParams(Object.entries({ q, limit: String(LIMIT), from, to }).filter((e): e is [string, string] => e[1] !== undefined));
      return (await get<{ items: ApiItem[] }>('/context/search', params)).items;
    },
    source: id => get<ApiSource>(`/sources/${id}`),
  };
}

export function fixtureBackend(fixture: Fixture): Backend {
  return {
    search: async (q, { from, to }) => {
      const key = [q, from, to].map(v => v ?? '').join('|');
      const hit = fixture.search[key];
      if (!hit) throw new Error(`fixture has no answer for ${key}`);
      return hit.items;
    },
    source: async id => {
      const hit = fixture.sources[id];
      if (!hit) throw new Error(`fixture has no source ${id}`);
      return hit;
    },
  };
}

/** One timed search. A failure is an answer with an error, so one bad call does not hide the other metrics. */
async function ask(backend: Backend, q: string, range: { from?: string; to?: string } = {}, resolveFor?: Fact): Promise<Answer> {
  const started = performance.now();
  const failures: string[] = [];
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
  try {
    const found = await backend.search(q, range);
    const ms = performance.now() - started;
    const items: Item[] = await Promise.all(found.slice(0, LIMIT).map(async item => {
      const resolve = resolveFor && matches(item.text, resolveFor.answers);
      const segments = resolve ? item.sources.flatMap(s => (s.segment_id ? [s.segment_id] : [])) : [];
      const times = await Promise.all(segments.map(async id => {
        try { return Date.parse((await backend.source(id)).event_at ?? ''); } catch (error) { failures.push(`${q}: source ${id}: ${reason(error)}`); return Number.NaN; }
      }));
      return { text: item.text, event_at: item.event_at, source_ms: times.filter(t => !Number.isNaN(t)) };
    }));
    return failures.length ? { items, ms, error: failures.join('; ') } : { items, ms };
  } catch (error) {
    return { items: [], ms: performance.now() - started, error: `${q}: ${reason(error)}` };
  }
}

export async function runCheckpoint(backend: Backend, manifest: Manifest, hours: number, t0_ms: number) {
  const { facts, ranges } = askable(manifest, hours);
  const iso = (offset_s: number) => new Date(t0_ms + offset_s * 1000).toISOString();
  const answers: { facts: Record<string, { keyword: Answer; natural: Answer }>; ranges: Record<string, Answer>; controls: Record<string, Answer> } = { facts: {}, ranges: {}, controls: {} };
  // Sequential on purpose: concurrent calls would put queueing time into the latency percentiles.
  for (const fact of facts) answers.facts[fact.id] = { keyword: await ask(backend, fact.query, {}, fact), natural: await ask(backend, fact.question, {}, fact) };
  for (const r of ranges) answers.ranges[r.id] = await ask(backend, r.query, { from: iso(r.from_s), to: iso(r.to_s) });
  for (const c of manifest.controls ?? []) answers.controls[c.id] = await ask(backend, c.query);
  return scoreCheckpoint({ hours, manifest, t0_ms, answers });
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    manifest: { type: 'string' }, hours: { type: 'string' }, out: { type: 'string' }, url: { type: 'string' },
    'token-env': { type: 'string', default: 'SANCTUM_SOAK_TOKEN' }, fixture: { type: 'string' }, t0: { type: 'string' },
  } });
  if (!values.manifest || !values.out || !values.hours || !CHECKPOINT_HOURS.includes(values.hours) || !(values.url || values.fixture)) {
    throw new Error('usage: checkpoint.ts --manifest m.json --hours 1|5|12|24 --out out.json (--url URL | --fixture f.json) [--token-env NAME] --t0 ISO');
  }
  const manifest = JSON.parse(readFileSync(values.manifest, 'utf8')) as Manifest;
  const t0 = values.t0;
  if (!t0 || Number.isNaN(Date.parse(t0))) throw new Error('--t0 is required: the run start as an ISO timestamp');
  const token = process.env[values['token-env']!];
  if (values.url && !token) throw new Error(`set ${values['token-env']} to an agent token with context:read`);
  const backend = values.fixture ? fixtureBackend(JSON.parse(readFileSync(values.fixture, 'utf8')) as Fixture) : httpBackend(values.url!, token!);
  const score = await runCheckpoint(backend, manifest, Number(values.hours), Date.parse(t0));
  writeFileSync(values.out, `${JSON.stringify({ asked_at: new Date().toISOString(), t0, ...score }, null, 2)}\n`);
  const m = score.metrics;
  console.log(`checkpoint ${values.hours}h: recall@5 ${m.recall_at_5} recall@20 ${m.recall_at_20} accuracy ${m.answer_accuracy} time-aware ${m.time_aware_accuracy} p50 ${m.latency_ms.p50?.toFixed(0)}ms p95 ${m.latency_ms.p95?.toFixed(0)}ms errors ${score.errors.length} -> ${values.out}`);
}
