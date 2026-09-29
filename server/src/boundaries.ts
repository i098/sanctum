/**
 * Automatic meeting boundary decisions (plan section 06). Pure functions over evidence the
 * caller gathers: the silence since the open meeting's last speech, its recent utterances
 * and the incoming one. A silence gap or topic change alone never makes a hard boundary.
 */
import type { BoundaryDecision, SourceRange } from '@sanctum/contracts';
import { engineeringDefaults } from './config.ts';

export interface Utterance {
  readonly text: string;
  readonly speaker_label: string | null;
  /** Speaker labels are only comparable within one provider connection. */
  readonly provider_connection_id: string | null;
}

export interface BoundaryEvidence {
  readonly source: SourceRange;
  readonly incoming: Utterance;
  /** Most recent utterances of the open meeting, oldest first; empty when no meeting is open. */
  readonly tail: ReadonlyArray<Utterance>;
  /** Silence since the open meeting's last speech; null when no meeting is open. */
  readonly gap_ms: number | null;
}

/** A `start` at or above this uncertainty opens a meeting that stays provisional until a person corrects it. */
export const LOW_CONFIDENCE = 0.4;
/** Continued coverage that promotes a confidently started provisional meeting to active. */
export const PROMOTE_AFTER_MS = 60_000;

// ponytail: English phrase lists are a naive heuristic; replace with a model-scored cue once labeled fixtures exist.
const END_CUE = /\b(thanks?( you)?,? (all|everyone|everybody)|that'?s (all|it) for today|let'?s wrap (it |this )?up|meeting (is )?adjourned|see you (all|next time|tomorrow)|bye,? (all|everyone|everybody)|goodbye)\b/i;
const START_CUE = /\b(let'?s (get )?(started|begin)|welcome,? (everyone|everybody|all)|kick (things |it )?off|good (morning|afternoon),? (everyone|everybody|all)|shall we (start|begin))\b/i;

const WEIGHTS = { explicit_end: 0.4, explicit_start: 0.4, long_gap: 0.3, extended_silence: 0.3, speaker_change: 0.2 } as const;
type Signal = keyof typeof WEIGHTS;

/** At least three words: a cough or "uh" does not open a conversation. */
const isCoherent = (text: string) => (text.match(/\p{L}+/gu) ?? []).length >= 3;

const speakerChanged = ({ incoming, tail }: BoundaryEvidence) => {
  const comparable = tail.filter(utterance => utterance.provider_connection_id !== null && utterance.provider_connection_id === incoming.provider_connection_id);
  return incoming.speaker_label !== null && comparable.length > 0 && comparable.every(utterance => utterance.speaker_label !== incoming.speaker_label);
};

const signalsOf = (evidence: BoundaryEvidence): ReadonlyArray<Signal> => {
  const gap = evidence.gap_ms ?? 0;
  const evaluation = engineeringDefaults.boundaryEvaluationGapMs;
  const present: Record<Signal, boolean> = {
    explicit_end: evidence.tail.slice(-2).some(utterance => END_CUE.test(utterance.text)),
    explicit_start: START_CUE.test(evidence.incoming.text),
    long_gap: gap >= evaluation,
    extended_silence: gap >= 6 * evaluation,
    speaker_change: speakerChanged(evidence),
  };
  return (Object.keys(present) as Array<Signal>).filter(signal => present[signal]);
};

const round = (value: number) => Math.round(value * 100) / 100;

/** `start` when enough independent evidence agrees; otherwise `continue`, carrying how likely a boundary was missed. */
export function evaluateBoundary(evidence: BoundaryEvidence): BoundaryDecision {
  if (evidence.gap_ms === null) {
    const coherent = isCoherent(evidence.incoming.text);
    return {
      decision: coherent ? 'start' : 'continue',
      source: evidence.source,
      evidence: coherent ? ['coherent_speech'] : [],
      reason: coherent ? 'coherent speech with no open meeting' : 'speech too short to open a meeting',
      uncertainty: 0.2,
    };
  }
  const signals = signalsOf(evidence);
  const triggered = signals.some(signal => signal !== 'speaker_change');
  const score = triggered ? Math.min(1, signals.reduce((total, signal) => total + WEIGHTS[signal], 0)) : 0;
  const start = score >= 0.5;
  return {
    decision: start ? 'start' : 'continue',
    source: evidence.source,
    evidence: [...signals],
    reason: start ? `boundary evidence: ${signals.join(', ')}` : triggered ? `insufficient boundary evidence: ${signals.join(', ')}` : 'continuing conversation',
    uncertainty: round(start ? 1 - score : score),
  };
}
