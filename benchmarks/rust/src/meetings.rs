//! `onFinalSegments` of server/src/meetings.ts and the meeting-store queries it runs: serialize on
//! the listener, load the open meeting, then claim, continue, promote, seal or open meetings per
//! final segment inside one transaction. Only the listener capture key (no capture group) is
//! ported: the benchmark fixture has no capture group.

use crate::boundaries::{Decision, LOW_CONFIDENCE, PROMOTE_AFTER_MS, Utterance, evaluate};
use crate::store::{Outcome, datetime_ms, db_time, enqueue_job, uuid};
use mysql::prelude::Queryable;
use mysql::{Row, TxOpts, Value as Sql};
use serde_json::json;
use std::collections::HashMap;

/// A final transcript segment as `segmentsWhere` returns it (the fields meeting placement reads).
pub struct Segment {
    pub epoch_id: String,
    pub track: u64,
    pub sample_start: u64,
    pub sample_end: u64,
    pub text: String,
    pub status: String,
    pub speaker_label: Option<String>,
    pub provider_connection_id: Option<String>,
}

impl Segment {
    fn source(&self) -> serde_json::Value {
        json!({ "epoch_id": self.epoch_id, "track": self.track, "sample_start": self.sample_start, "sample_end": self.sample_end })
    }
    fn utterance(&self) -> Utterance {
        Utterance {
            text: self.text.clone(),
            speaker_label: self.speaker_label.clone(),
            provider_connection_id: self.provider_connection_id.clone(),
        }
    }
}

#[derive(Clone)]
struct Epoch {
    id: String,
    sample_start: u64,
    sample_rate: u64,
    captured_ms: f64,
    timezone: String,
}

/// `sampleMs`: wall-clock milliseconds of a sample from the epoch anchor.
fn sample_ms(epoch: &Epoch, sample: u64) -> f64 {
    epoch.captured_ms + ((sample as f64 - epoch.sample_start as f64) * 1000.0) / epoch.sample_rate as f64
}

struct MeetingRow {
    id: String,
    workspace_id: String,
    state: String,
    started_ms: f64,
    boundary_revision: u64,
}

struct Last {
    epoch: Epoch,
    sample_end: u64,
}

struct Open {
    row: MeetingRow,
    last: Option<Last>,
    tail: Vec<Utterance>,
    opening_uncertainty: f64,
}

struct TimedRange {
    epoch: Epoch,
    epoch_id: String,
    track: u64,
    sample_start: u64,
    sample_end: u64,
    start_ms: f64,
    end_ms: f64,
}

/// `currentRanges`: the meeting's ranges at its current boundary revision, in wall-clock order.
fn current_ranges(q: &mut impl Queryable, workspace: &str, meeting: &str) -> Outcome<Vec<TimedRange>> {
    let rows: Vec<Row> = q.exec(
        "SELECT r.epoch_id, r.track, r.sample_start, r.sample_end, e.sample_start AS epoch_start, e.sample_rate, e.captured_at, e.timezone
        FROM meeting_ranges r
        JOIN meetings m ON m.id = r.meeting_id AND m.boundary_revision = r.boundary_revision
        JOIN capture_epochs e ON e.workspace_id = r.workspace_id AND e.id = r.epoch_id
        WHERE r.workspace_id = ? AND r.meeting_id = ?",
        (workspace, meeting),
    )?;
    let mut ranges: Vec<TimedRange> = rows
        .into_iter()
        .map(|row| {
            let epoch_id: String = row.get("epoch_id").unwrap();
            let epoch = Epoch {
                id: epoch_id.clone(),
                sample_start: row.get("epoch_start").unwrap(),
                sample_rate: row.get("sample_rate").unwrap(),
                captured_ms: datetime_ms(&row.get::<Sql, _>("captured_at").unwrap()),
                timezone: row.get("timezone").unwrap(),
            };
            let (sample_start, sample_end): (u64, u64) = (row.get("sample_start").unwrap(), row.get("sample_end").unwrap());
            TimedRange {
                start_ms: sample_ms(&epoch, sample_start),
                end_ms: sample_ms(&epoch, sample_end),
                epoch,
                epoch_id,
                track: row.get("track").unwrap(),
                sample_start,
                sample_end,
            }
        })
        .collect();
    ranges.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms).then(a.track.cmp(&b.track)));
    Ok(ranges)
}

/// The first range with the greatest end, like the TypeScript `reduce`.
fn latest(ranges: Vec<TimedRange>) -> Option<TimedRange> {
    ranges
        .into_iter()
        .reduce(|latest, range| if range.end_ms > latest.end_ms { range } else { latest })
}

fn record_boundary(q: &mut impl Queryable, row: &MeetingRow, operation: &str, decision: &Decision) -> Outcome<()> {
    q.exec_drop(
        "INSERT INTO boundary_events (id, workspace_id, meeting_id, boundary_revision, operation, decision, actor_principal_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))",
        (
            uuid(),
            &row.workspace_id,
            &row.id,
            row.boundary_revision,
            operation,
            decision.to_json().to_string(),
            Sql::NULL,
        ),
    )?;
    Ok(())
}

/// `planClaim`: bounds clipped before the next other owner; `extend` names the range to stretch.
fn plan_claim(segment: &Segment, latest: Option<(f64, f64)>, next: Option<f64>) -> (f64, f64, Option<f64>) {
    let end = (segment.sample_end as f64).min(next.unwrap_or(9_007_199_254_740_991.0));
    match latest {
        None => (segment.sample_start as f64, end, None),
        Some((start, stop)) => (
            stop.max(segment.sample_start as f64),
            end,
            (next.is_none() || next >= Some(segment.sample_end as f64)).then_some(start),
        ),
    }
}

/// `claimSource`: makes the meeting own the segment's source range; returns the owned end.
fn claim_source(q: &mut impl Queryable, row: &MeetingRow, segment: &Segment) -> Outcome<u64> {
    let latest: Option<(f64, f64)> = q.exec_first(
        "SELECT CAST(sample_start AS DOUBLE) AS sample_start, CAST(sample_end AS DOUBLE) AS sample_end
      FROM meeting_ranges WHERE meeting_id = ? AND boundary_revision = ? AND epoch_id = ? AND track = ?
        AND sample_start <= ? ORDER BY sample_start DESC LIMIT 1",
        (&row.id, row.boundary_revision, &segment.epoch_id, segment.track, segment.sample_start),
    )?;
    let after = latest.map_or(segment.sample_start as f64, |(start, _)| start);
    let next: Option<Option<u64>> = q.exec_first(
        "SELECT MIN(r.sample_start) AS next FROM meeting_ranges r
      JOIN meetings m ON m.id = r.meeting_id AND m.boundary_revision = r.boundary_revision
      WHERE r.workspace_id = ? AND r.epoch_id = ? AND r.track = ? AND r.sample_start > ?",
        (&row.workspace_id, &segment.epoch_id, segment.track, after),
    )?;
    let (from, end, extend) = plan_claim(segment, latest, next.flatten().map(|next| next as f64));
    if end <= from {
        return Ok(from as u64);
    }
    match extend {
        None => q.exec_drop(
            "INSERT INTO meeting_ranges (`workspace_id`,`meeting_id`,`boundary_revision`,`epoch_id`,`track`,`sample_start`,`sample_end`) VALUES (?,?,?,?,?,?,?)",
            (&row.workspace_id, &row.id, row.boundary_revision, &segment.epoch_id, segment.track, from as u64, end as u64),
        )?,
        Some(start) => q.exec_drop(
            "UPDATE meeting_ranges SET sample_end = ? WHERE (meeting_id = ? AND boundary_revision = ? AND epoch_id = ? AND track = ?) AND sample_start = ?",
            (end as u64, &row.id, row.boundary_revision, &segment.epoch_id, segment.track, start as u64),
        )?,
    }
    Ok(end as u64)
}

/// `sealMeeting` without a capture watermark: records the close and schedules final work.
fn seal_meeting(q: &mut impl Queryable, row: &MeetingRow, cue: &Decision) -> Outcome<()> {
    let last = latest(current_ranges(q, &row.workspace_id, &row.id)?).expect("an open meeting owns at least one range");
    q.exec_drop(
        "UPDATE meetings SET state = ?, ended_at = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND state IN (?, ?)",
        ("closing", db_time(last.end_ms), &row.id, "provisional", "active"),
    )?;
    // `{ decision: 'close', source, ...cue }` stores the cue itself: the spread overrides both fields.
    record_boundary(q, row, "close", cue)?;
    enqueue_job(
        q,
        &row.workspace_id,
        "meeting.finalize",
        &format!("meeting:{}", row.id),
        &json!({ "meeting_id": row.id }),
        None,
        0.0,
    )?;
    Ok(())
}

fn promote_if_established(q: &mut impl Queryable, mut open: Open, decision: &Decision, end_ms: f64) -> Outcome<Open> {
    let established = decision.evidence.contains(&"explicit_start") || end_ms - open.row.started_ms >= PROMOTE_AFTER_MS;
    if open.row.state != "provisional" || open.opening_uncertainty >= LOW_CONFIDENCE || !established {
        return Ok(open);
    }
    q.exec_drop(
        "UPDATE meetings SET state = 'active', updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND state = 'provisional'",
        (&open.row.id,),
    )?;
    record_boundary(q, &open.row, "promote", decision)?;
    open.row.state = "active".into();
    Ok(open)
}

fn create_meeting(q: &mut impl Queryable, workspace: &str, listener: &str, epoch: &Epoch, segment: &Segment, decision: &Decision) -> Outcome<Open> {
    let started = sample_ms(epoch, segment.sample_start);
    let row = MeetingRow {
        id: uuid(),
        workspace_id: workspace.into(),
        state: "provisional".into(),
        started_ms: started.trunc(),
        boundary_revision: 1,
    };
    q.exec_drop(
        "INSERT INTO meetings (id, workspace_id, capture_group_id, listener_id, state, timezone, started_at, boundary_revision, visibility, processing, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'provisional', ?, ?, 1, 'restricted', ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))",
        (&row.id, workspace, Sql::NULL, listener, &epoch.timezone, db_time(started), r#"{"transcript":"pending","notes":"pending","memory":"pending","recording":"pending"}"#),
    )?;
    let end = claim_source(q, &row, segment)?;
    record_boundary(q, &row, "start", decision)?;
    Ok(Open {
        row,
        last: Some(Last {
            epoch: epoch.clone(),
            sample_end: end,
        }),
        tail: vec![],
        opening_uncertainty: decision.uncertainty,
    })
}

fn gap_ms(open: &Open, epoch: &Epoch, sample: u64) -> f64 {
    match &open.last {
        None => 0.0,
        Some(last) if last.epoch.id == epoch.id => ((sample as f64 - last.sample_end as f64) * 1000.0) / epoch.sample_rate as f64,
        Some(last) => sample_ms(epoch, sample) - sample_ms(&last.epoch, last.sample_end),
    }
}

fn advance(mut open: Open, epoch: &Epoch, segment: &Segment, end: u64) -> Open {
    let keep = open.last.as_ref().is_some_and(|last| last.epoch.id == epoch.id && last.sample_end > end);
    if !keep {
        open.last = Some(Last {
            epoch: epoch.clone(),
            sample_end: end,
        });
    }
    open.tail.push(segment.utterance());
    if open.tail.len() > 2 {
        open.tail.remove(0);
    }
    open
}

fn continue_meeting(q: &mut impl Queryable, open: Open, epoch: &Epoch, segment: &Segment, decision: &Decision) -> Outcome<Open> {
    if sample_ms(epoch, segment.sample_start) < open.row.started_ms {
        return Ok(open);
    }
    let end = claim_source(q, &open.row, segment)?;
    promote_if_established(q, advance(open, epoch, segment, end), decision, sample_ms(epoch, segment.sample_end))
}

fn place_unowned(q: &mut impl Queryable, key: (&str, &str), epoch: &Epoch, segment: &Segment, open: Option<Open>) -> Outcome<Option<Open>> {
    let gap = open.as_ref().map(|open| gap_ms(open, epoch, segment.sample_start));
    let decision = evaluate(segment.source(), &segment.utterance(), open.as_ref().map_or(&[][..], |open| &open.tail), gap);
    match open {
        Some(open) if !decision.start => return continue_meeting(q, open, epoch, segment, &decision).map(Some),
        None if !decision.start => return Ok(None),
        Some(open) => seal_meeting(q, &open.row, &decision)?,
        None => {}
    }
    let mut created = create_meeting(q, key.0, key.1, epoch, segment, &decision)?;
    created.tail = vec![segment.utterance()];
    promote_if_established(q, created, &decision, sample_ms(epoch, segment.sample_end)).map(Some)
}

/// `placeSegment`: audio some meeting already owns only extends the open meeting past its range.
fn place_segment(q: &mut impl Queryable, key: (&str, &str), epoch: &Epoch, segment: &Segment, open: Option<Open>) -> Outcome<Option<Open>> {
    let owner: Option<(String, f64, f64)> = q.exec_first(
        "SELECT r.meeting_id, CAST(r.sample_start AS DOUBLE) AS sample_start, CAST(r.sample_end AS DOUBLE) AS sample_end FROM meeting_ranges r
        JOIN meetings m ON m.id = r.meeting_id AND m.boundary_revision = r.boundary_revision
        WHERE r.workspace_id = ? AND r.epoch_id = ? AND r.track = ?
          AND r.sample_start <= ? AND r.sample_end > ? LIMIT 1",
        (key.0, &segment.epoch_id, segment.track, segment.sample_start, segment.sample_start),
    )?;
    let Some((meeting, _, owned_end)) = owner else {
        return place_unowned(q, key, epoch, segment, open);
    };
    match open {
        Some(open) if meeting == open.row.id && segment.sample_end as f64 > owned_end => {
            let end = claim_source(q, &open.row, segment)?;
            Ok(Some(advance(open, epoch, segment, end)))
        }
        open => Ok(open),
    }
}

/// `loadOpen`: the listener's open meeting with its last speech position, recent utterances and opening uncertainty.
fn load_open(q: &mut impl Queryable, workspace: &str, listener: &str) -> Outcome<Option<Open>> {
    let found: Option<Row> = q.exec_first(
        "SELECT id, workspace_id, listener_id, capture_group_id, state, title, started_at, ended_at, timezone, boundary_revision, visibility, processing FROM meetings
        WHERE workspace_id = ? AND state IN (?, ?) AND listener_id = ? AND capture_group_id IS NULL ORDER BY started_at DESC LIMIT 1 FOR UPDATE",
        (workspace, "provisional", "active", listener),
    )?;
    let Some(found) = found else { return Ok(None) };
    let row = MeetingRow {
        id: found.get("id").unwrap(),
        workspace_id: found.get("workspace_id").unwrap(),
        state: found.get("state").unwrap(),
        started_ms: datetime_ms(&found.get::<Sql, _>("started_at").unwrap()),
        boundary_revision: found.get("boundary_revision").unwrap(),
    };
    let last = latest(current_ranges(q, &row.workspace_id, &row.id)?);
    let mut tail: Vec<Utterance> = match &last {
        None => vec![],
        Some(last) => q.exec_map(
            "SELECT text, speaker_label, provider_connection_id FROM transcript_segments
        WHERE workspace_id = ? AND epoch_id = ? AND track = ? AND status = 'final'
          AND sample_start >= ? AND sample_end <= ? ORDER BY sample_end DESC LIMIT 2",
            (&row.workspace_id, &last.epoch_id, last.track, last.sample_start, last.sample_end),
            |(text, speaker_label, provider_connection_id)| Utterance {
                text,
                speaker_label,
                provider_connection_id,
            },
        )?,
    };
    tail.reverse();
    let opening: Option<Option<String>> = q.exec_first(
        "SELECT JSON_EXTRACT(decision, '$.uncertainty') AS uncertainty FROM boundary_events
      WHERE meeting_id = ? AND operation IN ('start', 'split') ORDER BY created_at LIMIT 1",
        (&row.id,),
    )?;
    let opening_uncertainty = opening.flatten().and_then(|value| value.parse().ok()).unwrap_or(0.0);
    let last = last.map(|range| Last {
        epoch: range.epoch,
        sample_end: range.sample_end,
    });
    Ok(Some(Open {
        row,
        last,
        tail,
        opening_uncertainty,
    }))
}

fn load_epochs(q: &mut impl Queryable, workspace: &str, ids: &[&str]) -> Outcome<HashMap<String, Epoch>> {
    let marks = vec!["?"; ids.len()].join(", ");
    let params: Vec<Sql> = std::iter::once(Sql::from(workspace)).chain(ids.iter().map(|id| Sql::from(*id))).collect();
    let rows: Vec<Row> = q.exec(
        format!("SELECT id, sample_start, sample_rate, captured_at, timezone FROM capture_epochs WHERE workspace_id = ? AND id IN ({marks})"),
        params,
    )?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let epoch = Epoch {
                id: row.get("id").unwrap(),
                sample_start: row.get("sample_start").unwrap(),
                sample_rate: row.get("sample_rate").unwrap(),
                captured_ms: datetime_ms(&row.get::<Sql, _>("captured_at").unwrap()),
                timezone: row.get("timezone").unwrap(),
            };
            (epoch.id.clone(), epoch)
        })
        .collect())
}

/// Media hook: final segments for one listener, placed in wall-clock order in one transaction.
pub fn on_final_segments(conn: &mut mysql::PooledConn, workspace: &str, listener: &str, segments: &[Segment]) -> Outcome<()> {
    let finals: Vec<&Segment> = segments.iter().filter(|segment| segment.status == "final").collect();
    if finals.is_empty() {
        return Ok(());
    }
    let mut tx = conn.start_transaction(TxOpts::default())?;
    tx.exec_drop("SELECT id FROM listeners WHERE workspace_id = ? AND id = ? FOR UPDATE", (workspace, listener))?;
    let mut ids: Vec<&str> = finals.iter().map(|segment| segment.epoch_id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    let epochs = load_epochs(&mut tx, workspace, &ids)?;
    let mut known: Vec<&Segment> = finals.into_iter().filter(|segment| epochs.contains_key(&segment.epoch_id)).collect();
    known.sort_by(|a, b| sample_ms(&epochs[&a.epoch_id], a.sample_start).total_cmp(&sample_ms(&epochs[&b.epoch_id], b.sample_start)));
    let mut open = load_open(&mut tx, workspace, listener)?;
    for segment in known {
        open = place_segment(&mut tx, (workspace, listener), &epochs[&segment.epoch_id], segment, open)?;
    }
    tx.commit()?;
    Ok(())
}
