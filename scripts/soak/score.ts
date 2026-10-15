/**
 * Soak checkpoint scoring (pure). `checkpoint.ts` asks the questions and times the calls; this file
 * turns the answers into recall@k, answer accuracy, latest-wins accuracy, time-aware accuracy and latency percentiles.
 * It reads the corpus `manifest.json` (build-corpus.ts): `t0`, `facts` and `checkpoints[].questions`.
 *
 * A fact is "found" when an item in the top k matches one of its answer aliases AND cites a
 * transcript segment within `PLANT_TOLERANCE_MS` of the time it was really played. Search sorts newest
 * first with no relevance ranking (server/src/context.ts), so older facts falling out of the top k is the signal.
 */

const MAX_K = 20;
const PLANT_TOLERANCE_MS = 2 * 60_000;

/** The driver fills this in at run start. */
export interface T0Slot { readonly epoch_s: number | null; readonly tz: string | null }
/** The answer is a date that depends on when the fact was really said: the first `weekday` after that day. `after_s` equals the fact's `at_s`. */
export interface DateExpectation { readonly kind: 'weekday_after'; readonly weekday: string; readonly after_s: number }
export interface Fact {
  readonly id: string;
  /** Seconds from T0 at which the corpus plants the fact. */
  readonly at_s: number;
  /** When the driver really played the fact (event time, ISO), including any outage shift; absent means T0 + `at_s`. */
  readonly actual_at?: string;
  /** Whole-token spellings of the expected answer ("Nov 3", "November 3"); empty when `expect` is set. */
  readonly aliases: ReadonlyArray<string>;
  readonly expect?: DateExpectation;
}
export type Mode = 'current' | 'as_of' | 'range' | 'history' | 'never_said';
export interface Question {
  readonly id: string;
  /** The question as a person would ask it; reported separately from the keyword form. */
  readonly question: string;
  /** Keywords as an agent would send them (search ANDs every term of 3+ characters); null only for `range`. */
  readonly keywords: string | null;
  readonly mode: Mode;
  /** Fact ids that answer it: all of them for `range`, in order for `history`, the newest for `current` and `as_of`. */
  readonly expect: ReadonlyArray<string>;
  readonly as_of_s?: number;
  readonly range_s?: readonly [number, number];
}
export interface Manifest {
  readonly t0: T0Slot;
  readonly alias_match: 'whole_token';
  readonly facts: ReadonlyArray<Fact>;
  readonly checkpoints: ReadonlyArray<{ readonly id: string; readonly at_s: number; readonly questions: ReadonlyArray<Question> }>;
}
/** A fact with the instant it was really played and the spellings it is matched against: its aliases, or the dates its `expect` resolves to. */
export interface DueFact extends Fact { readonly planted_ms: number; readonly answers: ReadonlyArray<string> }
export interface DueQuestion extends Question { readonly facts: ReadonlyArray<DueFact> }

/** One returned item; `source_ms` holds the event times (epoch ms) of its cited segments, when resolved. */
export interface Item { readonly text: string; readonly event_at: string | null; readonly source_ms: ReadonlyArray<number> }
export interface Answer { readonly items: ReadonlyArray<Item>; readonly ms: number; readonly error?: string }
/** The two forms of one question: keywords, and the person's sentence. */
export interface QuestionAnswers { readonly keyword: Answer; readonly natural: Answer }
export type FactStatus = 'found' | 'wrong' | 'missing';

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

/** The questions of the checkpoint at `hours`, each with its expected facts placed at their real instant and their answers resolved. */
export function dueQuestions(manifest: Manifest, hours: number): DueQuestion[] {
  if (manifest.alias_match !== 'whole_token') throw new Error(`unsupported alias_match "${String(manifest.alias_match)}"`);
  const t0_ms = t0Ms(manifest);
  const checkpoint = manifest.checkpoints.find(c => c.at_s === hours * 3600);
  if (!checkpoint) throw new Error(`manifest has no ${hours} h checkpoint`);
  const place = (id: string): DueFact => {
    const fact = manifest.facts.find(f => f.id === id);
    if (!fact) throw new Error(`question expects unknown fact ${id}`);
    const planted_ms = fact.actual_at === undefined ? t0_ms + fact.at_s * 1000 : Date.parse(fact.actual_at);
    if (Number.isNaN(planted_ms)) throw new Error(`fact ${id}: actual_at "${fact.actual_at}" is not a timestamp`);
    return { ...fact, planted_ms, answers: fact.expect ? weekdayAfterAnswers(fact.expect, planted_ms, manifest.t0.tz) : fact.aliases };
  };
  return checkpoint.questions.map(q => ({ ...q, facts: q.expect.map(place) }));
}

/** Search window of a question (`from` inclusive, `to` exclusive, on event time); empty for questions about the present. */
export function windowOf(q: Question, t0_ms: number): { from?: string; to?: string } {
  const iso = (offset_s: number) => new Date(t0_ms + offset_s * 1000).toISOString();
  if (q.mode === 'as_of') return { to: iso(q.as_of_s!) };
  if (q.mode === 'range') return { from: iso(q.range_s![0]), to: iso(q.range_s![1]) };
  return {};
}

/** found: top-k item matches the answer at the time it was played; wrong: items returned but none do; missing: nothing returned. */
function factStatus(fact: DueFact, answer: Answer, k: number): FactStatus {
  const top = answer.items.slice(0, k);
  const hit = top.some(i => matches(i.text, fact.answers) && i.source_ms.some(t => Math.abs(t - fact.planted_ms) <= PLANT_TOLERANCE_MS));
  return hit ? 'found' : top.length ? 'wrong' : 'missing';
}

/** The newest match is the expected answer: search is newest first, so a stale answer on top means a later fact was lost. */
const newestIs = (answer: Answer, fact: DueFact) => answer.items[0] !== undefined && matches(answer.items[0].text, fact.answers);

const inWindow = (answer: Answer, { from, to }: { from?: string; to?: string }) => answer.items.every(i => {
  const at = i.event_at === null ? null : Date.parse(i.event_at);
  return at === null || ((from === undefined || at >= Date.parse(from)) && (to === undefined || at < Date.parse(to)));
});

/** Event times of the facts' own items, in the order given; strictly increasing means the history reads in order. */
const inOrder = (answer: Answer, facts: ReadonlyArray<DueFact>) => {
  const times = facts.map(f => answer.items.find(i => matches(i.text, f.answers) && i.source_ms.some(t => Math.abs(t - f.planted_ms) <= PLANT_TOLERANCE_MS))?.event_at);
  return times.every((t, i) => t != null && (i === 0 || Date.parse(t) > Date.parse(times[i - 1]!)));
};

/** Time-aware questions: the result is right only for the window or order the question names. */
function timeAwareCorrect(q: DueQuestion, answer: Answer, t0_ms: number) {
  if (answer.error) return false;
  if (q.mode === 'as_of') return inWindow(answer, windowOf(q, t0_ms)) && newestIs(answer, q.facts[0]!);
  if (q.mode === 'range') return inWindow(answer, windowOf(q, t0_ms)) && q.facts.every(f => factStatus(f, answer, Infinity) === 'found');
  return q.facts.every(f => factStatus(f, answer, MAX_K) === 'found') && inOrder(answer, q.facts);
}

/** Nearest-rank percentile; null for no samples. */
export function percentile(values: ReadonlyArray<number>, p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

const ratio = (num: number, den: number) => (den ? num / den : null);
const RANK: Readonly<Record<FactStatus, number>> = { missing: 0, wrong: 1, found: 2 };
const best = (a: FactStatus | undefined, b: FactStatus): FactStatus => (a !== undefined && RANK[a] >= RANK[b] ? a : b);

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
  /** One row per distinct expected fact; the best status over the questions that expect it. */
  readonly facts: ReadonlyArray<{ readonly id: string; readonly keyword: FactStatus; readonly natural: FactStatus }>;
  /** Time-aware questions (`as_of`, `range`, `history`). */
  readonly ranges: ReadonlyArray<{ readonly id: string; readonly correct: boolean }>;
  /** `never_said` questions: passed when the keyword search returns nothing. */
  readonly controls: ReadonlyArray<{ readonly id: string; readonly passed: boolean }>;
  readonly errors: ReadonlyArray<string>;
}

export function scoreCheckpoint(input: { readonly hours: number; readonly manifest: Manifest; readonly answers: Readonly<Record<string, QuestionAnswers>> }): CheckpointScore {
  const { hours, manifest, answers } = input;
  const t0_ms = t0Ms(manifest);
  const questions = dueQuestions(manifest, hours);
  const of = (q: DueQuestion) => answers[q.id]!;
  const pairs = questions.filter(q => q.mode === 'current' || q.mode === 'as_of' || q.mode === 'history')
    .flatMap(q => q.facts.map(fact => ({ fact, ...of(q) })));
  const recall = (k: number) => ratio(pairs.filter(p => factStatus(p.fact, p.keyword, k) === 'found').length, pairs.length);
  const rows = new Map<string, { keyword: FactStatus; natural: FactStatus }>();
  for (const q of questions) {
    for (const fact of q.facts) {
      const k = q.mode === 'range' ? Infinity : MAX_K;
      const row = rows.get(fact.id);
      rows.set(fact.id, { keyword: best(row?.keyword, factStatus(fact, of(q).keyword, k)), natural: best(row?.natural, factStatus(fact, of(q).natural, k)) });
    }
  }
  const current = questions.filter(q => q.mode === 'current');
  const timeAware = questions.filter(q => q.mode === 'as_of' || q.mode === 'range' || q.mode === 'history').map(q => ({ id: q.id, correct: timeAwareCorrect(q, of(q).keyword, t0_ms) }));
  const controls = questions.filter(q => q.mode === 'never_said').map(q => ({ id: q.id, passed: !of(q).keyword.error && of(q).keyword.items.length === 0 }));
  const all = questions.flatMap(q => [of(q).keyword, of(q).natural]);
  return {
    checkpoint_hours: hours,
    metrics: {
      recall_at_5: recall(5),
      recall_at_20: recall(MAX_K),
      natural_recall_at_20: ratio(pairs.filter(p => factStatus(p.fact, p.natural, MAX_K) === 'found').length, pairs.length),
      answer_accuracy: ratio(pairs.filter(p => p.keyword.items.slice(0, MAX_K).some(i => matches(i.text, p.fact.answers))).length, pairs.length),
      latest_accuracy: ratio(current.filter(q => newestIs(of(q).keyword, q.facts[0]!)).length, current.length),
      time_aware_accuracy: ratio(timeAware.filter(r => r.correct).length, timeAware.length),
      control_pass_rate: ratio(controls.filter(c => c.passed).length, controls.length),
      latency_ms: { p50: percentile(all.map(a => a.ms), 0.5), p95: percentile(all.map(a => a.ms), 0.95), samples: all.length },
    },
    facts: [...rows].map(([id, row]) => ({ id, ...row })),
    ranges: timeAware,
    controls,
    errors: all.flatMap(a => (a.error ? [a.error] : [])),
  };
}
