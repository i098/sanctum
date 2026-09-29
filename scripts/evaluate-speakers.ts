/**
 * Speaker attribution evaluation (plan sections 09 and 18): scores hypothesis speaker turns
 * against a labeled reference, keeping false identity (a wrong name) separate from diarization
 * confusion and from honest "unknown" answers. Inputs are JSON files of turns in seconds:
 *   reference:  [{ "start": 0, "end": 4.2, "person": "alice" | null }]   (null = unenrolled participant)
 *   hypothesis: [{ "start": 0, "end": 4.0, "label": "SPEAKER_00", "person": "alice" | null }]
 * Usage: node scripts/evaluate-speakers.ts reference.json hypothesis.json
 * It measures only the fixtures given; it is not evidence of real-world model quality.
 */
import { readFileSync } from 'node:fs';

export interface ReferenceTurn { start: number; end: number; person: string | null }
export interface HypothesisTurn { start: number; end: number; label: string; person: string | null }

export interface SpeakerReport {
  /** Reference speech seconds (overlapping speakers count once per speaker). */
  speech_s: number;
  /** Reference seconds no hypothesis turn covered. */
  missed_s: number;
  /** Seconds named as a different person than the reference speaker, or named when the reference is unknown. */
  false_identity_s: number;
  /** Seconds correctly named. */
  correct_identity_s: number;
  /** Seconds left unnamed although the reference speaker is known: safe, but a recall gap. */
  unnamed_known_s: number;
  /** Seconds where one hypothesis label covers more than one reference speaker (diarization confusion). */
  label_confusion_s: number;
  false_identity_rate: number;
}

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const round = (value: number) => Math.round(value * 1000) / 1000;

type Totals = Omit<SpeakerReport, 'false_identity_rate'>;

/** Adds one reference turn's overlap with every hypothesis turn to the totals; returns seconds covered. */
function scoreTurn(ref: ReferenceTurn, hypothesis: ReadonlyArray<HypothesisTurn>, totals: Totals, byLabel: Map<string, Map<string, number>>): number {
  const person = ref.person ?? '?unknown';
  let covered = 0;
  for (const hyp of hypothesis) {
    const shared = overlap(ref, hyp);
    covered += shared;
    const people = byLabel.get(hyp.label) ?? new Map<string, number>();
    people.set(person, (people.get(person) ?? 0) + shared);
    byLabel.set(hyp.label, people);
    const key = hyp.person === null ? (ref.person === null ? null : 'unnamed_known_s') : hyp.person === ref.person ? 'correct_identity_s' : 'false_identity_s';
    if (key !== null) totals[key] += shared;
  }
  return covered;
}

export function evaluateSpeakers(reference: ReadonlyArray<ReferenceTurn>, hypothesis: ReadonlyArray<HypothesisTurn>): SpeakerReport {
  const totals: Totals = { speech_s: 0, missed_s: 0, false_identity_s: 0, correct_identity_s: 0, unnamed_known_s: 0, label_confusion_s: 0 };
  // Majority reference speaker per hypothesis label: time attributed to any other speaker is confusion.
  const byLabel = new Map<string, Map<string, number>>();
  for (const ref of reference) {
    totals.speech_s += ref.end - ref.start;
    totals.missed_s += Math.max(0, ref.end - ref.start - scoreTurn(ref, hypothesis, totals, byLabel));
  }
  for (const people of byLabel.values()) {
    const times = [...people.values()];
    totals.label_confusion_s += times.reduce((sum, time) => sum + time, 0) - Math.max(...times);
  }
  const rounded = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round(value)])) as Totals;
  return { ...rounded, false_identity_rate: totals.speech_s === 0 ? 0 : round(totals.false_identity_s / totals.speech_s) };
}

if (import.meta.main) {
  const [referencePath, hypothesisPath] = process.argv.slice(2);
  if (referencePath === undefined || hypothesisPath === undefined) {
    console.error('Usage: node scripts/evaluate-speakers.ts reference.json hypothesis.json');
    process.exitCode = 2;
  } else {
    const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
    console.log(JSON.stringify(evaluateSpeakers(read(referencePath), read(hypothesisPath)), null, 2));
  }
}
