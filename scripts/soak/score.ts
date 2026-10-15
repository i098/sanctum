/**
 * Soak checkpoint scoring (pure). `checkpoint.ts` asks the questions and times the calls; this file
 * turns the answers into recall@k, answer accuracy, time-aware accuracy and latency percentiles.
 *
 * A fact is "found" when an item in the top k matches one of its answer aliases AND cites a
 * transcript segment within `PLANT_TOLERANCE_MS` of the planted time. Search sorts newest first with
 * no relevance ranking (server/src/context.ts), so older facts falling out of the top k is the signal.
 */

const MAX_K = 20;
const PLANT_TOLERANCE_MS = 2 * 60_000;
/** A fact planted within this many seconds of a checkpoint may not have been extracted yet (meeting close + distill). */
const SETTLE_S = 15 * 60;

/** `manifest.json` subset this scorer reads. Offsets are seconds from T0. */
export interface T0Slot { readonly epoch_s: number | null; readonly tz: string | null }
/** The answer is a date that depends on when the fact was really said: the first `weekday` after that day. */
export interface DateExpectation { readonly kind: 'weekday_after'; readonly weekday: string }
export interface Fact {
  readonly id: string;
  readonly at_s: number;
  /** When the driver really played the fact (event time, ISO), including any outage shift; absent means T0 + `at_s`. */
  readonly actual_at?: string;
  /** Keywords, as an agent would send: search ANDs every term of 3+ characters. */
  readonly query: string;
  /** The same question as a person would ask it; reported separately. */
  readonly question: string;
  /** Whole-token spellings of the expected answer ("Nov 3", "November 3"); empty when `expect` is set. */
  readonly aliases: ReadonlyArray<string>;
  readonly expect?: DateExpectation;
  /** The newest match must be this fact's answer (a later plant changes it). */
  readonly latest?: boolean;
}
/** A fact with its planted instant and the spellings it is matched against: its aliases, or the dates its `expect` resolves to. */
export interface DueFact extends Fact { readonly planted_ms: number; readonly answers: ReadonlyArray<string> }
/** Time-aware question: results inside [from_s, to_s] only, and every `expect` answer must appear. */
export interface RangeQuestion {
  readonly id: string;
  readonly query: string;
  readonly from_s: number;
  readonly to_s: number;
  readonly expect: ReadonlyArray<ReadonlyArray<string>>;
}
/** Question whose answer was never said: it must return no item. */
export interface Control { readonly id: string; readonly query: string }
export interface Manifest {
  readonly t0: T0Slot;
  readonly facts: ReadonlyArray<Fact>;
  readonly ranges?: ReadonlyArray<RangeQuestion>;
  readonly controls?: ReadonlyArray<Control>;
}

/** One returned item; `source_ms` holds the event times (epoch ms) of its cited segments, when resolved. */
export interface Item { readonly text: string; readonly event_at: string | null; readonly source_ms: ReadonlyArray<number> }
export interface Answer { readonly items: ReadonlyArray<Item>; readonly ms: number; readonly error?: string }

export type FactStatus = 'found' | 'wrong' | 'missing';

export interface Answers {
  readonly facts: Readonly<Record<string, { readonly keyword: Answer; readonly natural: Answer }>>;
  readonly ranges: Readonly<Record<string, Answer>>;
  readonly controls: Readonly<Record<string, Answer>>;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const matches = (text: string, answers: ReadonlyArray<string>) => {
  const haystack = ` ${normalize(text)} `;
  return answers.some(a => haystack.includes(` ${normalize(a)} `));
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function t0Ms(manifest: Manifest) {
  if (manifest.t0.epoch_s === null) throw new Error('manifest.t0.epoch_s is not set: the driver writes it when the run starts');
  return manifest.t0.epoch_s * 1000;
}

/** Date spellings of the first `weekday` strictly after the instant, on the calendar of the run's time zone. */
function weekdayAfterAnswers(expect: DateExpectation, instant_ms: number, tz: string | null): string[] {
  const target = WEEKDAYS.indexOf(expect.weekday.toLowerCase());
  if (target < 0 || !tz) throw new Error(`cannot resolve weekday_after "${expect.weekday}" with time zone ${tz}`);
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(instant_ms).split('-').map(Number);
  const day = new Date(Date.UTC(y!, m! - 1, d! + 1));
  while (day.getUTCDay() !== target) day.setUTCDate(day.getUTCDate() + 1);
  const [month, n] = [MONTHS[day.getUTCMonth()]!, day.getUTCDate()];
  const short = month.slice(0, 3);
  const ordinal = `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
  return [day.toISOString().slice(0, 10), `${month} ${n}`, `${month} ${ordinal}`, `${short} ${n}`, `${short} ${ordinal}`, `${n} ${month}`, `${n} ${short}`, `${day.getUTCMonth() + 1}/${n}`];
}

/** Facts and ranges old enough to have been processed by this checkpoint; each fact carries its real planted instant and resolved answers. */
export function askable(manifest: Manifest, hours: number) {
  const t0_ms = t0Ms(manifest);
  const placed = manifest.facts.map(f => {
    const planted_ms = f.actual_at === undefined ? t0_ms + f.at_s * 1000 : Date.parse(f.actual_at);
    if (Number.isNaN(planted_ms)) throw new Error(`fact ${f.id}: actual_at "${f.actual_at}" is not a timestamp`);
    return { f, planted_ms };
  });
  return {
    facts: placed.filter(p => p.planted_ms - t0_ms <= hours * 3_600_000 - SETTLE_S * 1000)
      .map(({ f, planted_ms }): DueFact => ({ ...f, planted_ms, answers: f.expect ? weekdayAfterAnswers(f.expect, planted_ms, manifest.t0.tz) : f.aliases })),
    ranges: (manifest.ranges ?? []).filter(r => r.to_s <= hours * 3600 - SETTLE_S),
  };
}

/** found: top-k item matches the answer at the planted time; wrong: items returned but none do; missing: nothing returned. */
function factStatus(fact: DueFact, answer: Answer, k: number): FactStatus {
  const top = answer.items.slice(0, k);
  const hit = top.some(i => matches(i.text, fact.answers) && i.source_ms.some(t => Math.abs(t - fact.planted_ms) <= PLANT_TOLERANCE_MS));
  return hit ? 'found' : top.length ? 'wrong' : 'missing';
}

/** Right answers only, and nothing from outside the window. */
function rangeCorrect(range: RangeQuestion, answer: Answer, t0_ms: number) {
  const from = t0_ms + range.from_s * 1000;
  const to = t0_ms + range.to_s * 1000;
  const inside = answer.items.every(i => i.event_at === null || (Date.parse(i.event_at) >= from && Date.parse(i.event_at) <= to));
  return !answer.error && inside && range.expect.every(alias => answer.items.some(i => matches(i.text, alias)));
}

/** Nearest-rank percentile; null for no samples. */
export function percentile(values: ReadonlyArray<number>, p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

const ratio = (num: number, den: number) => (den ? num / den : null);

export interface CheckpointScore {
  readonly checkpoint_hours: number;
  readonly metrics: {
    readonly recall_at_5: number | null;
    readonly recall_at_20: number | null;
    readonly natural_recall_at_20: number | null;
    readonly answer_accuracy: number | null;
    readonly latest_accuracy: number | null;
    readonly time_aware_accuracy: number | null;
    readonly control_pass_rate: number | null;
    readonly latency_ms: { readonly p50: number | null; readonly p95: number | null; readonly samples: number };
  };
  readonly facts: ReadonlyArray<{ readonly id: string; readonly keyword: FactStatus; readonly natural: FactStatus }>;
  readonly ranges: ReadonlyArray<{ readonly id: string; readonly correct: boolean }>;
  readonly controls: ReadonlyArray<{ readonly id: string; readonly passed: boolean }>;
  readonly errors: ReadonlyArray<string>;
}

export function scoreCheckpoint(input: { readonly hours: number; readonly manifest: Manifest; readonly answers: Answers }): CheckpointScore {
  const { hours, manifest, answers } = input;
  const t0_ms = t0Ms(manifest);
  const { facts, ranges } = askable(manifest, hours);
  const controls = manifest.controls ?? [];
  const factRows = facts.map(fact => {
    const { keyword, natural } = answers.facts[fact.id]!;
    return { fact, keyword, natural };
  });
  const factResults = factRows.map(({ fact, keyword, natural }) => ({ id: fact.id, keyword: factStatus(fact, keyword, MAX_K), natural: factStatus(fact, natural, MAX_K) }));
  const rangeResults = ranges.map(r => ({ id: r.id, correct: rangeCorrect(r, answers.ranges[r.id]!, t0_ms) }));
  const controlResults = controls.map(c => ({ id: c.id, passed: !answers.controls[c.id]!.error && answers.controls[c.id]!.items.length === 0 }));
  const recall = (k: number) => ratio(factRows.filter(r => factStatus(r.fact, r.keyword, k) === 'found').length, factRows.length);
  const latest = factRows.filter(r => r.fact.latest);
  const all = [...factRows.flatMap(r => [r.keyword, r.natural]), ...ranges.map(r => answers.ranges[r.id]!), ...controls.map(c => answers.controls[c.id]!)];
  return {
    checkpoint_hours: hours,
    metrics: {
      recall_at_5: recall(5),
      recall_at_20: recall(20),
      natural_recall_at_20: ratio(factResults.filter(r => r.natural === 'found').length, factResults.length),
      answer_accuracy: ratio(factRows.filter(r => r.keyword.items.slice(0, MAX_K).some(i => matches(i.text, r.fact.answers))).length, factRows.length),
      latest_accuracy: ratio(latest.filter(r => r.keyword.items[0] !== undefined && matches(r.keyword.items[0].text, r.fact.answers)).length, latest.length),
      time_aware_accuracy: ratio(rangeResults.filter(r => r.correct).length, rangeResults.length),
      control_pass_rate: ratio(controlResults.filter(c => c.passed).length, controlResults.length),
      latency_ms: { p50: percentile(all.map(a => a.ms), 0.5), p95: percentile(all.map(a => a.ms), 0.95), samples: all.length },
    },
    facts: factResults,
    ranges: rangeResults,
    controls: controlResults,
    errors: all.flatMap(a => (a.error ? [a.error] : [])),
  };
}
