/**
 * Soak retrieval checkpoint: asks the corpus manifest's questions for one checkpoint through
 * `GET /api/v1/context/search` (keyword form and natural-language form of each; `as_of` and `range`
 * questions use the `from`/`to` window; a range question with no keywords lists the window and
 * follows `next_cursor`), resolves the cited segments of matching items through
 * `GET /api/v1/sources/{id}`, scores the answers and writes JSON.
 * It only reads; it never records, writes context or calls a paid model.
 *
 * Usage: node scripts/soak/checkpoint.ts --manifest manifest.json --hours 1|5|12|24 --out cp-1h.json
 *          (--url https://sanctum.example [--token-env SANCTUM_SOAK_TOKEN] | --fixture search-fixture.json)
 * T0 and its time zone come from `manifest.t0` (`epoch_s`, `tz`), which the driver fills in when the run starts.
 * A fact's real play time comes from its `actual_at` when the driver recorded one, else T0 + `at_s`.
 *
 * A fixture replaces the hosted app with recorded responses:
 *   { "search": { "<q>|<from>|<to>": { "items": [ContextItem...] } }, "sources": { "<segment_id>": Source } }
 * with empty parts for a missing `q`, `from` or `to`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dueQuestions, matches, scoreCheckpoint, t0Ms, windowOf } from './score.ts';
import type { Answer, DueFact, Item, Manifest, QuestionAnswers } from './score.ts';

const KEYWORD_LIMIT = 20;
const LISTING_PAGE = 200;
const LISTING_PAGES = 10;
const CHECKPOINT_HOURS = ['1', '5', '12', '24'];

interface ApiItem { readonly text: string; readonly event_at: string | null; readonly sources: ReadonlyArray<{ readonly segment_id?: string }> }
interface ApiSource { readonly kind: string; readonly event_at?: string }
interface Fixture { readonly search: Readonly<Record<string, { readonly items: ReadonlyArray<ApiItem> }>>; readonly sources: Readonly<Record<string, ApiSource>> }

/** Where answers come from: the hosted API or a recorded fixture. A null `q` lists the window. */
interface Backend {
  search(q: string | null, window: { readonly from?: string; readonly to?: string }): Promise<ReadonlyArray<ApiItem>>;
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
      const items: ApiItem[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < (q === null ? LISTING_PAGES : 1); page++) {
        const params = new URLSearchParams(Object.entries({ q: q ?? undefined, limit: String(q === null ? LISTING_PAGE : KEYWORD_LIMIT), from, to, cursor: cursor ?? undefined }).filter((e): e is [string, string] => e[1] !== undefined));
        const result: { items: ApiItem[]; next_cursor: string | null } = await get('/context/search', params);
        items.push(...result.items);
        cursor = result.next_cursor;
        if (cursor === null) break;
      }
      return items;
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
async function ask(backend: Backend, q: string | null, window: { from?: string; to?: string }, expected: ReadonlyArray<DueFact>): Promise<Answer> {
  const started = performance.now();
  const failures: string[] = [];
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
  try {
    const found = await backend.search(q, window);
    const ms = performance.now() - started;
    const answers = expected.flatMap(f => f.answers);
    const items: Item[] = await Promise.all(found.map(async item => {
      const resolve = matches(item.text, answers);
      const segments = resolve ? item.sources.flatMap(s => (s.segment_id ? [s.segment_id] : [])) : [];
      const times = await Promise.all(segments.map(async id => {
        try { return Date.parse((await backend.source(id)).event_at ?? ''); } catch (error) { failures.push(`${q ?? "listing"}: source ${id}: ${reason(error)}`); return Number.NaN; }
      }));
      return { text: item.text, event_at: item.event_at, source_ms: times.filter(t => !Number.isNaN(t)) };
    }));
    return failures.length ? { items, ms, error: failures.join('; ') } : { items, ms };
  } catch (error) {
    return { items: [], ms: performance.now() - started, error: `${q ?? "listing"}: ${reason(error)}` };
  }
}

export async function runCheckpoint(backend: Backend, manifest: Manifest, hours: number) {
  const t0_ms = t0Ms(manifest);
  const answers: Record<string, QuestionAnswers> = {};
  // Sequential on purpose: concurrent calls would put queueing time into the latency percentiles.
  for (const q of dueQuestions(manifest, hours)) {
    const window = windowOf(q, t0_ms);
    answers[q.id] = { keyword: await ask(backend, q.keywords, window, q.facts), natural: await ask(backend, q.question, window, q.facts) };
  }
  return scoreCheckpoint({ hours, manifest, answers });
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    manifest: { type: 'string' }, hours: { type: 'string' }, out: { type: 'string' }, url: { type: 'string' },
    'token-env': { type: 'string', default: 'SANCTUM_SOAK_TOKEN' }, fixture: { type: 'string' },
  } });
  if (!values.manifest || !values.out || !values.hours || !CHECKPOINT_HOURS.includes(values.hours) || !(values.url || values.fixture)) {
    throw new Error('usage: checkpoint.ts --manifest m.json --hours 1|5|12|24 --out out.json (--url URL | --fixture f.json) [--token-env NAME]');
  }
  const manifest = JSON.parse(readFileSync(values.manifest, 'utf8')) as Manifest;
  const token = process.env[values['token-env']!];
  if (values.url && !token) throw new Error(`set ${values['token-env']} to an agent token with context:read`);
  const backend = values.fixture ? fixtureBackend(JSON.parse(readFileSync(values.fixture, 'utf8')) as Fixture) : httpBackend(values.url!, token!);
  const score = await runCheckpoint(backend, manifest, Number(values.hours));
  writeFileSync(values.out, `${JSON.stringify({ asked_at: new Date().toISOString(), t0: new Date(t0Ms(manifest)).toISOString(), ...score }, null, 2)}\n`);
  const m = score.metrics;
  console.log(`checkpoint ${values.hours}h: recall@5 ${m.recall_at_5} recall@20 ${m.recall_at_20} accuracy ${m.answer_accuracy} time-aware ${m.time_aware_accuracy} p50 ${m.latency_ms.p50?.toFixed(0)}ms p95 ${m.latency_ms.p95?.toFixed(0)}ms errors ${score.errors.length} -> ${values.out}`);
  // Errors are transport/auth failures, not retrieval misses: fail loudly so an unattended wrapper notices.
  if (score.errors.length) process.exitCode = 1;
}
