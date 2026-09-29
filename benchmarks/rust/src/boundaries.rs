//! `evaluateBoundary` of server/src/boundaries.ts: pure meeting-boundary decisions from the silence
//! gap, recent utterances and the incoming utterance.

use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;

pub const LOW_CONFIDENCE: f64 = 0.4;
pub const PROMOTE_AFTER_MS: f64 = 60_000.0;
/// `engineeringDefaults.boundaryEvaluationGapMs`.
const EVALUATION_GAP_MS: f64 = 5.0 * 60_000.0;

static END_CUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(thanks?( you)?,? (all|everyone|everybody)|that'?s (all|it) for today|let'?s wrap (it |this )?up|meeting (is )?adjourned|see you (all|next time|tomorrow)|bye,? (all|everyone|everybody)|goodbye)\b").unwrap()
});
static START_CUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(let'?s (get )?(started|begin)|welcome,? (everyone|everybody|all)|kick (things |it )?off|good (morning|afternoon),? (everyone|everybody|all)|shall we (start|begin))\b").unwrap()
});
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{L}+").unwrap());

#[derive(Clone)]
pub struct Utterance {
    pub text: String,
    pub speaker_label: Option<String>,
    pub provider_connection_id: Option<String>,
}

pub struct Decision {
    pub start: bool,
    pub source: Value,
    pub evidence: Vec<&'static str>,
    pub reason: String,
    pub uncertainty: f64,
}

impl Decision {
    /// The `BoundaryDecision` JSON `recordBoundary` stores, in the same key order.
    pub fn to_json(&self) -> Value {
        json!({ "decision": if self.start { "start" } else { "continue" }, "source": self.source, "evidence": self.evidence, "reason": self.reason, "uncertainty": self.uncertainty })
    }
}

fn speaker_changed(incoming: &Utterance, tail: &[Utterance]) -> bool {
    let comparable: Vec<&Utterance> = tail
        .iter()
        .filter(|u| u.provider_connection_id.is_some() && u.provider_connection_id == incoming.provider_connection_id)
        .collect();
    incoming.speaker_label.is_some() && !comparable.is_empty() && comparable.iter().all(|u| u.speaker_label != incoming.speaker_label)
}

/// Signals present, in the `WEIGHTS` key order, with their weights.
fn signals(incoming: &Utterance, tail: &[Utterance], gap: f64) -> Vec<(&'static str, f64)> {
    let recent = &tail[tail.len().saturating_sub(2)..];
    [
        ("explicit_end", 0.4, recent.iter().any(|u| END_CUE.is_match(&u.text))),
        ("explicit_start", 0.4, START_CUE.is_match(&incoming.text)),
        ("long_gap", 0.3, gap >= EVALUATION_GAP_MS),
        ("extended_silence", 0.3, gap >= 6.0 * EVALUATION_GAP_MS),
        ("speaker_change", 0.2, speaker_changed(incoming, tail)),
    ]
    .into_iter()
    .filter_map(|(name, weight, present)| present.then_some((name, weight)))
    .collect()
}

fn round(value: f64) -> f64 {
    crate::measure::js_round(value * 100.0) / 100.0
}

/// `start` when enough independent evidence agrees; otherwise `continue`.
pub fn evaluate(source: Value, incoming: &Utterance, tail: &[Utterance], gap_ms: Option<f64>) -> Decision {
    let Some(gap) = gap_ms else {
        let coherent = WORD.find_iter(&incoming.text).count() >= 3;
        let reason = if coherent {
            "coherent speech with no open meeting"
        } else {
            "speech too short to open a meeting"
        };
        return Decision {
            start: coherent,
            source,
            evidence: if coherent { vec!["coherent_speech"] } else { vec![] },
            reason: reason.into(),
            uncertainty: 0.2,
        };
    };
    let present = signals(incoming, tail, gap);
    let names: Vec<&'static str> = present.iter().map(|(name, _)| *name).collect();
    let triggered = names.iter().any(|name| *name != "speaker_change");
    let score = if triggered {
        present.iter().map(|(_, weight)| weight).sum::<f64>().min(1.0)
    } else {
        0.0
    };
    let start = score >= 0.5;
    let reason = match (start, triggered) {
        (true, _) => format!("boundary evidence: {}", names.join(", ")),
        (false, true) => format!("insufficient boundary evidence: {}", names.join(", ")),
        (false, false) => "continuing conversation".into(),
    };
    Decision {
        start,
        source,
        evidence: names,
        reason,
        uncertainty: round(if start { 1.0 - score } else { score }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(text: &str) -> Utterance {
        Utterance {
            text: text.into(),
            speaker_label: None,
            provider_connection_id: None,
        }
    }

    #[test]
    fn coherent_speech_opens_and_cues_with_a_gap_start_a_new_meeting() {
        assert!(evaluate(json!({}), &said("the pilot rollout plan"), &[], None).start);
        assert!(!evaluate(json!({}), &said("uh hm"), &[], None).start);
        let continuing = evaluate(json!({}), &said("more on the rollout"), &[said("so the plan")], Some(0.0));
        assert_eq!(
            (continuing.start, continuing.reason.as_str(), continuing.uncertainty),
            (false, "continuing conversation", 0.0)
        );
        let split = evaluate(
            json!({}),
            &said("Good morning everyone, let's get started"),
            &[said("Thanks everyone")],
            Some(EVALUATION_GAP_MS),
        );
        assert_eq!(
            (split.start, split.evidence, split.uncertainty),
            (true, vec!["explicit_end", "explicit_start", "long_gap"], 0.0)
        );
    }
}
