/**
 * Structured extraction (plan sections 08 and 09, T15): context candidates and one canonical
 * meeting summary from final transcript segments. Output is grounded in code, not trusted:
 * every candidate cites known segment IDs, spoken facts carry a verbatim quote, and relative
 * times resolve against the utterance's own time in the meeting timezone, never the job's clock.
 * Ungrounded model output is dropped and logged; nothing is invented when the model is unavailable.
 */
import {
  type CaptureEpochId,
  type ContextItem,
  ContextKind,
  type ExtractionCandidate,
  type Meeting,
  type MeetingId,
  type TranscriptSegment,
  Unavailable,
  UtcTimestamp,
} from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { engineeringDefaults } from './config.ts';
import { type Llm, LlmClient } from './llm.ts';

/**
 * The extraction role first; any failure (no key, timeout, invalid output) sends the same request once to the
 * planner's Workers AI Qwen, as the spoken classifier does. Both calls get the longer extraction timeout
 * and patient retries, since these are background jobs.
 */
const generateWithFallback = <A, I>(llm: Llm, request: { readonly name: string; readonly output: Schema.Schema<A, I>; readonly system: string; readonly prompt: string }) => {
  const timed = { ...request, timeoutMs: engineeringDefaults.modelRequest.extractionTimeoutMs, patient: true };
  return llm.generate('extraction', timed).pipe(
    Effect.catchAll(error =>
      Effect.zipRight(Effect.logWarning(`Extraction model unavailable for ${request.name}; falling back to planner: ${error.message}`), llm.generate('planner', timed)),
    ),
  );
};

/** UTC instant of a capture epoch's first sample (`capture_epochs.sample_start` / `captured_at`). */
export interface EpochAnchor {
  readonly epoch_id: CaptureEpochId;
  readonly sample_rate: number;
  readonly sample_start: number;
  readonly captured_at: UtcTimestamp;
}

export interface ExtractionInput {
  readonly meeting: Meeting;
  readonly segments: ReadonlyArray<TranscriptSegment>;
  /** Existing items to show the model: the caller's relevant candidates, not necessarily the whole meeting. `relevantContext` fits them to the budget. */
  readonly snapshot: ReadonlyArray<ContextItem>;
  /** Kind and text of every current item of the meeting, so a repeat of any of them is rejected even when it is not in `snapshot`. */
  readonly known?: ReadonlyArray<Pick<ContextItem, 'kind' | 'text'>>;
  /**
   * The last segment an earlier round already processed, shown as context so a sentence cut at the batch edge reaches the model whole.
   * A candidate must cite at least one of `segments`; the model is told not to extract the earlier line alone.
   */
  readonly earlier?: ReadonlyArray<TranscriptSegment>;
  /** Anchor for every segment's epoch; without one a segment cannot be placed in time and extraction fails. */
  readonly epochs?: ReadonlyArray<EpochAnchor>;
}

/** Canonical notes: the one summary that notes, email discussion sections and exports render. */
export interface MeetingNotes {
  readonly meeting_id: MeetingId;
  readonly model: string;
  readonly title: string;
  readonly summary: string;
  readonly sections: ReadonlyArray<{ readonly heading: string; readonly points: ReadonlyArray<{ readonly text: string; readonly sources: ExtractionCandidate['sources'] }> }>;
}

const TimeMention = Schema.Struct({
  phrase: Schema.String,
  /** Resolved wall time in the meeting timezone, `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, or null. */
  local: Schema.NullOr(Schema.String),
  ambiguous: Schema.Boolean,
});
const CandidatesOutput = Schema.Struct({
  candidates: Schema.Array(
    Schema.Struct({
      kind: ContextKind,
      text: Schema.String,
      quote: Schema.NullOr(Schema.String),
      derivation: Schema.Literal('spoken', 'inferred'),
      segments: Schema.Array(Schema.String),
      time: Schema.NullOr(TimeMention),
    }),
  ),
});
const NotesOutput = Schema.Struct({
  title: Schema.String,
  summary: Schema.String,
  sections: Schema.Array(Schema.Struct({ heading: Schema.String, points: Schema.Array(Schema.Struct({ text: Schema.String, segments: Schema.Array(Schema.String) })) })),
});

interface Line {
  readonly ref: string;
  /** Position among the meeting's final segments in time order; consecutive positions are adjacent speech. */
  readonly index: number;
  readonly segment: TranscriptSegment;
  /** UTC epoch milliseconds of the segment start. */
  readonly at: number;
  readonly source: ExtractionCandidate['sources'][number];
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

/** Wall-clock `YYYY-MM-DDTHH:MM:SS` of a UTC instant in `timeZone`. */
function wallClock(utcMs: number, timeZone: string): string {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const part = Object.fromEntries(format.formatToParts(utcMs).map(({ type, value }) => [type, value]));
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}`;
}

/** Every UTC instant whose wall clock in `timeZone` is `wall`: none in a DST gap, two in a DST overlap. */
function instantsAt(wall: string, timeZone: string): number[] {
  const naive = Date.parse(`${wall}Z`);
  const offsets = [naive - 86_400_000, naive + 86_400_000].map(probe => Date.parse(`${wallClock(probe, timeZone)}Z`) - probe);
  return [...new Set(offsets.map(offset => naive - offset))].filter(instant => wallClock(instant, timeZone) === wall);
}

/** A date without a time of day normalizes to local midnight but stays ambiguous for exact scheduling. */
function resolveTime(mention: typeof TimeMention.Type, anchorMs: number, timeZone: Meeting['timezone']): NonNullable<ExtractionCandidate['time']> {
  const match = mention.local === null ? null : WALL.exec(mention.local);
  const instants = match ? instantsAt(`${match[1]}-${match[2]}-${match[3]}T${match[4] ?? '00'}:${match[5] ?? '00'}:00`, timeZone) : [];
  const exact = instants.length === 1 && !mention.ambiguous;
  return {
    phrase: mention.phrase,
    normalized: instants.length === 1 ? UtcTimestamp.make(new Date(instants[0]!).toISOString()) : null,
    anchor: UtcTimestamp.make(new Date(anchorMs).toISOString()),
    timezone: timeZone,
    ambiguous: !(exact && match?.[4] !== undefined),
  };
}

/** Case- and punctuation-insensitive text for verbatim checks. */
const fold = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Whether `phrase` is verbatim in one of `runs`. ASR splits and joins words ("North wind" for "Northwind"), so spaces are
 * ignored, but the match must still start and end on a word edge of the run ("ship" is not in "relationship").
 */
export function quoted(runs: ReadonlyArray<string>, phrase: string): boolean {
  const target = fold(phrase).replaceAll(' ', '');
  if (target === '') return false;
  return runs.some(run => {
    const words = fold(run).split(' ');
    return words.some((_, start) => {
      let joined = '';
      for (let end = start; end < words.length && joined.length < target.length; end++) joined += words[end];
      return joined === target;
    });
  });
}

/** Final segments inside the meeting, in time order, with short citation refs and meeting-relative milliseconds. */
function timeline(input: ExtractionInput): Effect.Effect<Line[], Unavailable> {
  const anchors = new Map(input.epochs?.map(anchor => [anchor.epoch_id, anchor]));
  const started = Date.parse(input.meeting.started_at);
  const placed: Array<Omit<Line, 'ref' | 'index'>> = [];
  for (const segment of input.segments) {
    if (segment.status !== 'final') continue;
    const anchor = anchors.get(segment.source.epoch_id);
    if (!anchor) return Effect.fail(new Unavailable({ message: `no capture epoch anchor for epoch ${segment.source.epoch_id}`, retryable: false }));
    const utc = (sample: number) => Date.parse(anchor.captured_at) + ((sample - anchor.sample_start) * 1000) / anchor.sample_rate;
    const at = utc(segment.source.sample_start);
    if (at < started) continue;
    placed.push({ segment, at, source: { segment_id: segment.id, start_ms: Math.round(at - started), end_ms: Math.round(utc(segment.source.sample_end) - started) } });
  }
  return Effect.succeed(placed.sort((a, b) => a.at - b.at).map((line, i) => ({ ...line, ref: `S${i + 1}`, index: i })));
}

function transcriptBlock(lines: ReadonlyArray<Line>, meeting: Meeting): string {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: meeting.timezone, weekday: 'short' });
  return lines
    .map(line => `${line.ref} [${weekday.format(line.at)} ${wallClock(line.at, meeting.timezone).replace('T', ' ')}] ${line.segment.speaker_label ?? 'unknown speaker'}: ${line.segment.text}`)
    .join('\n');
}

const EXTRACTION_SYSTEM = `You extract durable meeting context from a transcript.
Return only new facts that are not already in the existing context.
Kinds: decision, commitment (someone agreed to do something), constraint, project_fact, preference, open_question, research_observation.
Cite every fact with the transcript refs (S1, S2, ...) it comes from.
derivation "spoken": the fact is said outright; quote must copy words from the cited lines exactly.
derivation "inferred": the fact follows from what was said but is not stated; quote may be null.
For a date or time, copy the phrase exactly as spoken and resolve it against the local time of the line that says it, in the meeting timezone:
local is "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM", or null when it cannot be resolved; set ambiguous when more than one reading is plausible.
Never guess names, dates or facts that the transcript does not support.`;

const NOTES_SYSTEM = `You write the canonical notes for a meeting from its transcript.
Give a short title, a summary paragraph of at most 80 words, and sections of at most 8 discussion points in total, each under 40 words.
Every point lists in segments the transcript refs (for example ["S1", "S3"]) that support it; segments holds only refs, never text. Leave out anything the transcript does not support.`;

const NOTES_TITLE_SYSTEM = `You write the title and summary of a meeting from the summaries of its consecutive parts.
Give a short title and a summary paragraph of at most 120 words. Leave out anything the part summaries do not say.`;

type ModelCandidate = (typeof CandidatesOutput.Type)['candidates'][number];

/** Whether a candidate re-extracts the overlap: it cites no fresh segment, or its quote sits wholly in an earlier-round segment and in no fresh one. */
export function echoesEarlier(quote: string | null, cited: ReadonlyArray<{ readonly text: string; readonly fresh: boolean }>): boolean {
  if (!cited.some(line => line.fresh)) return true;
  const holds = (fresh: boolean) => quote !== null && cited.some(line => line.fresh === fresh && quoted([line.text], quote));
  return holds(false) && !holds(true);
}

/** Joined text of each run of transcript-adjacent cited segments; a quote must sit inside one run, never stitch across a gap. */
export function adjacentRuns(cited: ReadonlyArray<{ readonly index: number; readonly text: string }>): string[] {
  const texts: string[] = [];
  [...cited].sort((a, b) => a.index - b.index).forEach((line, i, sorted) => {
    if (i > 0 && line.index === sorted[i - 1]!.index + 1) texts[texts.length - 1] += ` ${line.text}`;
    else texts.push(line.text);
  });
  return texts;
}

/** Why a candidate's text, quote or time phrase is not supported by its cited lines, or null. */
function unsupported(candidate: ModelCandidate, heard: ReadonlyArray<string>, known: ReadonlySet<string>): string | null {
  const verbatim = (text: string) => quoted(heard, text);
  const checks: ReadonlyArray<readonly [boolean, string]> = [
    [fold(candidate.text) !== '' && !known.has(`${candidate.kind}:${fold(candidate.text)}`), 'empty or already in the context snapshot'],
    [candidate.derivation === 'inferred' || candidate.quote !== null, 'spoken candidate without a quote'],
    [candidate.quote === null || verbatim(candidate.quote), 'quote is not verbatim in adjacent cited segments'],
    [candidate.time === null || verbatim(candidate.time.phrase), 'time phrase is not in adjacent cited segments'],
  ];
  return checks.find(([ok]) => !ok)?.[1] ?? null;
}

/** The grounded candidate, or why it was rejected. */
function ground(candidate: ModelCandidate, byRef: ReadonlyMap<string, Line>, meeting: Meeting, known: ReadonlySet<string>, fresh: ReadonlySet<string>): ExtractionCandidate | string {
  const cited = [...new Set(candidate.segments)].map(ref => byRef.get(ref));
  if (cited.length === 0 || cited.some(line => line === undefined)) return 'cites unknown transcript segments';
  const lines = cited as Line[];
  if (echoesEarlier(candidate.quote, lines.map(line => ({ text: line.segment.text, fresh: fresh.has(line.segment.id) })))) return 'cites only what an earlier round processed';
  const reason = unsupported(candidate, adjacentRuns(lines.map(line => ({ index: line.index, text: line.segment.text }))), known);
  if (reason !== null) return reason;
  const phrase = candidate.time?.phrase;
  const said = lines.find(line => phrase !== undefined && quoted([line.segment.text], phrase)) ?? lines.reduce((a, b) => (b.index > a.index ? b : a));
  return {
    kind: candidate.kind,
    text: candidate.text.trim(),
    quote: candidate.quote,
    derivation: candidate.derivation,
    sources: lines.map(line => line.source),
    time: candidate.time && resolveTime(candidate.time, said.at, meeting.timezone),
  };
}

/** Characters of existing context one extraction prompt carries (about 1k tokens), however large the meeting grows. */
const CONTEXT_BUDGET_CHARS = 4_000;
/** Newest items always offered first, so the model sees what was just said even without a shared term. */
export const RECENT_ITEMS = 12;
/** Most term-sharing items a caller fetches as candidates; the budget keeps about 30 of them. */
export const MATCHING_ITEMS = 60;

/** Distinct content words as 5-letter prefixes, so "launch" matches "launched" and "shipping" matches "shipped". */
export const contentTerms = (text: string) => new Set(fold(text).split(' ').filter(word => word.length > 3).map(word => word.slice(0, 5)));

/**
 * The existing-context prompt block for these new segments, oldest first, within `CONTEXT_BUDGET_CHARS`: the newest
 * `RECENT_ITEMS`, then items that share terms with the segments, rarest shared terms first, so a fact that
 * supersedes or repeats an older one still sees it. `items` run oldest to newest: the meeting's newest items and
 * its term-sharing items from any age (`relevantItems`).
 * ponytail: term overlap, no embeddings; add a vector lookup if paraphrased supersession is missed.
 */
function relevantContext(items: ReadonlyArray<ContextItem>, segmentText: string): string {
  const spoken = contentTerms(segmentText);
  const itemTerms = items.map(item => contentTerms(item.text));
  const frequency = new Map<string, number>();
  for (const own of itemTerms) for (const term of own) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const ranked = items.map((_, index) => ({ index, score: [...itemTerms[index]!].reduce((sum, term) => sum + (spoken.has(term) ? 1 / frequency.get(term)! : 0), 0) }));
  const order = [
    ...ranked.slice(-RECENT_ITEMS).reverse(),
    ...ranked.slice(0, -RECENT_ITEMS).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || b.index - a.index),
  ];
  const lines = items.map(item => `- ${item.kind}: ${item.text}`);
  const chosen: number[] = [];
  let used = 0;
  for (const { index } of order) {
    if (used + lines[index]!.length + 1 > CONTEXT_BUDGET_CHARS) continue;
    used += lines[index]!.length + 1;
    chosen.push(index);
  }
  return chosen.sort((a, b) => a - b).map(index => lines[index]).join('\n');
}

/** Context candidates grounded in the meeting's final segments; the context slice validates access and commits them. */
export const extractCandidates = (input: ExtractionInput): Effect.Effect<ReadonlyArray<ExtractionCandidate>, Unavailable, LlmClient> =>
  Effect.gen(function* () {
    const fresh = new Set(input.segments.map(segment => segment.id));
    const lines = yield* timeline({ ...input, segments: [...(input.earlier ?? []), ...input.segments] });
    if (!lines.some(line => fresh.has(line.segment.id))) return [];
    const llm = yield* LlmClient;
    const existing = input.snapshot.filter(item => item.state !== 'superseded');
    const context = relevantContext(existing, lines.map(line => line.segment.text).join(' ')) || '(none)';
    const earlier = lines.filter(line => !fresh.has(line.segment.id)).map(line => line.ref);
    const overlap = earlier.length === 0 ? '' : `\n\n${earlier.join(', ')} was processed in an earlier round, shown only so a sentence cut at the round edge is whole: cite it only together with a later line that completes the fact, and extract nothing it says alone.`;
    const { value } = yield* generateWithFallback(llm, {
      name: 'context_candidates',
      output: CandidatesOutput,
      system: EXTRACTION_SYSTEM,
      prompt: `Meeting timezone: ${input.meeting.timezone}\n\nExisting context:\n${context}\n\nTranscript:\n${transcriptBlock(lines, input.meeting)}${overlap}`,
    });
    const byRef = new Map(lines.map(line => [line.ref, line]));
    const known = new Set([...existing, ...(input.known ?? [])].map(item => `${item.kind}:${fold(item.text)}`));
    const results = value.candidates.map(candidate => ground(candidate, byRef, input.meeting, known, fresh));
    const rejected = results.flatMap((result, i) => (typeof result === 'string' ? [{ text: value.candidates[i]!.text, reason: result }] : []));
    if (rejected.length > 0) yield* Effect.logWarning('extraction dropped ungrounded candidates', rejected);
    return results.filter((result): result is ExtractionCandidate => typeof result !== 'string');
  });

/** Transcript lines per notes request, so one request's output stays far below the output cap however long the meeting is. */
const NOTES_WINDOW = 120;
/** Notes requests in flight at once; Cerebras queues and Workers AI is slow, so this stays low. */
const NOTES_CONCURRENCY = 3;

/** Margin above the model stages: the former fixed ceiling of every model job. */
const NOTES_MARGIN_MS = 15 * 60_000;

/**
 * Time one notes run may take: each stage (`NOTES_CONCURRENCY` window requests at once, then the title request when there is
 * more than one window) may spend the extraction call and then the planner fallback at `extractionTimeoutMs` each, plus
 * `NOTES_MARGIN_MS`, never above the job's hard ceiling.
 */
export const notesCeilingMs = (windows: number) => {
  const stages = Math.ceil(windows / NOTES_CONCURRENCY) + (windows > 1 ? 1 : 0);
  return Math.min(engineeringDefaults.jobs.ceilingByKind['notes.summarize'] ?? engineeringDefaults.jobs.ceilingMs, NOTES_MARGIN_MS + stages * 2 * engineeringDefaults.modelRequest.extractionTimeoutMs);
};

const TitleOutput = Schema.Struct({ title: Schema.String, summary: Schema.String });

/**
 * One canonical summary per meeting, every point cited; points citing unknown segments are dropped.
 * The transcript is summarized in windows of `NOTES_WINDOW` lines, each bounded in output; with more than
 * one window a final request writes the title and summary from the window summaries.
 */
export const summarizeMeeting = (input: Omit<ExtractionInput, 'snapshot'>): Effect.Effect<MeetingNotes, Unavailable, LlmClient> =>
  Effect.gen(function* () {
    const lines = yield* timeline({ ...input, snapshot: [] });
    if (lines.length === 0) return yield* new Unavailable({ message: 'meeting has no final transcript to summarize', retryable: false });
    const llm = yield* LlmClient;
    const windows = Array.from({ length: Math.ceil(lines.length / NOTES_WINDOW) }, (_, i) => lines.slice(i * NOTES_WINDOW, (i + 1) * NOTES_WINDOW));
    const { parts, head } = yield* Effect.gen(function* () {
      const parts = yield* Effect.forEach(
        windows,
        part => generateWithFallback(llm, {
          name: 'meeting_notes',
          output: NotesOutput,
          system: NOTES_SYSTEM,
          prompt: `Meeting timezone: ${input.meeting.timezone}\n\nTranscript:\n${transcriptBlock(part, input.meeting)}`,
        }),
        { concurrency: NOTES_CONCURRENCY },
      );
      const head = parts.length === 1
        ? parts[0]!
        : yield* generateWithFallback(llm, {
          name: 'meeting_notes_title',
          output: TitleOutput,
          system: NOTES_TITLE_SYSTEM,
          prompt: parts.map(({ value }, i) => `Part ${i + 1}: ${value.summary}`).join('\n\n'),
        });
      return { parts, head };
    }).pipe(
      Effect.timeoutFail({
        duration: notesCeilingMs(windows.length),
        onTimeout: () => new Unavailable({ message: `notes model calls exceeded ${notesCeilingMs(windows.length)} ms for ${windows.length} transcript windows`, retryable: true }),
      }),
    );
    const byRef = new Map(lines.map(line => [line.ref, line]));
    const written = parts.flatMap(({ value }) => value.sections);
    const sections = written
      .map(section => ({
        heading: section.heading.trim(),
        points: section.points
          .filter(point => point.text.trim() !== '' && point.segments.length > 0 && point.segments.every(ref => byRef.has(ref)))
          .map(point => ({ text: point.text.trim(), sources: [...new Set(point.segments)].map(ref => byRef.get(ref)!.source) })),
      }))
      .filter(section => section.points.length > 0);
    const dropped = written.reduce((count, section) => count + section.points.length, 0) - sections.reduce((count, section) => count + section.points.length, 0);
    if (dropped > 0) yield* Effect.logWarning(`notes dropped ${dropped} ungrounded points`);
    if (head.value.summary.trim() === '') return yield* new Unavailable({ message: 'notes model returned an empty summary', retryable: false });
    return { meeting_id: input.meeting.id, model: head.model, title: head.value.title.trim(), summary: head.value.summary.trim(), sections };
  });
