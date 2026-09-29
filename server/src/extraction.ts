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
import { LlmClient } from './llm.ts';

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
  readonly snapshot: ReadonlyArray<ContextItem>;
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

/** Final segments inside the meeting, in time order, with short citation refs and meeting-relative milliseconds. */
function timeline(input: ExtractionInput): Effect.Effect<Line[], Unavailable> {
  const anchors = new Map(input.epochs?.map(anchor => [anchor.epoch_id, anchor]));
  const started = Date.parse(input.meeting.started_at);
  const placed: Array<Omit<Line, 'ref'>> = [];
  for (const segment of input.segments) {
    if (segment.status !== 'final') continue;
    const anchor = anchors.get(segment.source.epoch_id);
    if (!anchor) return Effect.fail(new Unavailable({ message: `no capture epoch anchor for epoch ${segment.source.epoch_id}`, retryable: false }));
    const utc = (sample: number) => Date.parse(anchor.captured_at) + ((sample - anchor.sample_start) * 1000) / anchor.sample_rate;
    const at = utc(segment.source.sample_start);
    if (at < started) continue;
    placed.push({ segment, at, source: { segment_id: segment.id, start_ms: Math.round(at - started), end_ms: Math.round(utc(segment.source.sample_end) - started) } });
  }
  return Effect.succeed(placed.sort((a, b) => a.at - b.at).map((line, i) => ({ ...line, ref: `S${i + 1}` })));
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
Give a short title, a summary paragraph, and sections of discussion points.
Every point cites the transcript refs (S1, S2, ...) that support it. Leave out anything the transcript does not support.`;

type ModelCandidate = (typeof CandidatesOutput.Type)['candidates'][number];

/** Why a candidate's text, quote or time phrase is not supported by its cited lines, or null. */
function unsupported(candidate: ModelCandidate, heard: string, known: ReadonlySet<string>): string | null {
  const verbatim = (text: string) => fold(text) !== '' && heard.includes(fold(text));
  const checks: ReadonlyArray<readonly [boolean, string]> = [
    [fold(candidate.text) !== '' && !known.has(`${candidate.kind}:${fold(candidate.text)}`), 'empty or already in the context snapshot'],
    [candidate.derivation === 'inferred' || candidate.quote !== null, 'spoken candidate without a quote'],
    [candidate.quote === null || verbatim(candidate.quote), 'quote is not verbatim in the cited segments'],
    [candidate.time === null || verbatim(candidate.time.phrase), 'time phrase is not in the cited segments'],
  ];
  return checks.find(([ok]) => !ok)?.[1] ?? null;
}

/** The grounded candidate, or why it was rejected. */
function ground(candidate: ModelCandidate, byRef: ReadonlyMap<string, Line>, meeting: Meeting, known: ReadonlySet<string>): ExtractionCandidate | string {
  const cited = [...new Set(candidate.segments)].map(ref => byRef.get(ref));
  if (cited.length === 0 || cited.some(line => line === undefined)) return 'cites unknown transcript segments';
  const lines = cited as Line[];
  const reason = unsupported(candidate, fold(lines.map(line => line.segment.text).join(' ')), known);
  if (reason !== null) return reason;
  const phrase = candidate.time && fold(candidate.time.phrase);
  const said = lines.find(line => phrase !== null && fold(line.segment.text).includes(phrase)) ?? lines[0]!;
  return {
    kind: candidate.kind,
    text: candidate.text.trim(),
    quote: candidate.quote,
    derivation: candidate.derivation,
    sources: lines.map(line => line.source),
    time: candidate.time && resolveTime(candidate.time, said.at, meeting.timezone),
  };
}

/** Context candidates grounded in the meeting's final segments; the context slice validates access and commits them. */
export const extractCandidates = (input: ExtractionInput): Effect.Effect<ReadonlyArray<ExtractionCandidate>, Unavailable, LlmClient> =>
  Effect.gen(function* () {
    const lines = yield* timeline(input);
    if (lines.length === 0) return [];
    const llm = yield* LlmClient;
    const existing = input.snapshot.filter(item => item.state !== 'superseded');
    const context = existing.map(item => `- ${item.kind}: ${item.text}`).join('\n') || '(none)';
    const { value } = yield* llm.generate('extraction', {
      name: 'context_candidates',
      output: CandidatesOutput,
      system: EXTRACTION_SYSTEM,
      prompt: `Meeting timezone: ${input.meeting.timezone}\n\nExisting context:\n${context}\n\nTranscript:\n${transcriptBlock(lines, input.meeting)}`,
    });
    const byRef = new Map(lines.map(line => [line.ref, line]));
    const known = new Set(existing.map(item => `${item.kind}:${fold(item.text)}`));
    const results = value.candidates.map(candidate => ground(candidate, byRef, input.meeting, known));
    const rejected = results.flatMap((result, i) => (typeof result === 'string' ? [{ text: value.candidates[i]!.text, reason: result }] : []));
    if (rejected.length > 0) yield* Effect.logWarning('extraction dropped ungrounded candidates', rejected);
    return results.filter((result): result is ExtractionCandidate => typeof result !== 'string');
  });

/** One canonical summary per meeting, every point cited; points citing unknown segments are dropped. */
export const summarizeMeeting = (input: Omit<ExtractionInput, 'snapshot'>): Effect.Effect<MeetingNotes, Unavailable, LlmClient> =>
  Effect.gen(function* () {
    const lines = yield* timeline({ ...input, snapshot: [] });
    if (lines.length === 0) return yield* new Unavailable({ message: 'meeting has no final transcript to summarize', retryable: false });
    const llm = yield* LlmClient;
    const { value, model } = yield* llm.generate('extraction', {
      name: 'meeting_notes',
      output: NotesOutput,
      system: NOTES_SYSTEM,
      prompt: `Meeting timezone: ${input.meeting.timezone}\n\nTranscript:\n${transcriptBlock(lines, input.meeting)}`,
    });
    const byRef = new Map(lines.map(line => [line.ref, line]));
    const sections = value.sections
      .map(section => ({
        heading: section.heading.trim(),
        points: section.points
          .filter(point => point.text.trim() !== '' && point.segments.length > 0 && point.segments.every(ref => byRef.has(ref)))
          .map(point => ({ text: point.text.trim(), sources: [...new Set(point.segments)].map(ref => byRef.get(ref)!.source) })),
      }))
      .filter(section => section.points.length > 0);
    const dropped = value.sections.reduce((count, section) => count + section.points.length, 0) - sections.reduce((count, section) => count + section.points.length, 0);
    if (dropped > 0) yield* Effect.logWarning(`notes dropped ${dropped} ungrounded points`);
    if (value.summary.trim() === '') return yield* new Unavailable({ message: 'notes model returned an empty summary', retryable: false });
    return { meeting_id: input.meeting.id, model, title: value.title.trim(), summary: value.summary.trim(), sections };
  });
