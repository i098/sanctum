//! `transcript_ingest`: `publishFinalWindow` of server/src/transcripts.ts (one transaction per
//! final window: epoch lock, coverage, revisioned segments, coverage upsert) followed by the
//! meeting hook, over the `transcript-segments-v1` fixture.

use crate::measure::{RecordInput, sample, sha256_hex, to_record};
use crate::meetings::{Segment, on_final_segments};
use crate::store::{Fixture, Outcome, count_failure, uuid};
use mysql::prelude::Queryable;
use mysql::{Row, TxOpts, Value as Sql};
use serde_json::{Value, json};

const SPAN: u64 = 48_000 * 5;
const ORIGIN: &str = "live";

fn text(i: usize) -> String {
    let mut text = format!("Segment {i}: {}", "discussion of the pilot rollout ".repeat(8));
    text.truncate(240);
    text
}

/// Latest revision of `text` at the window, or a new revision; returns inserted segment IDs.
fn insert_fresh(q: &mut impl Queryable, fx: &Fixture, window: (u64, u64), text: &str, covered: &[(u64, u64, String)]) -> Outcome<Vec<String>> {
    let midpoint = (window.0 + window.1) as f64 / 2.0;
    let duplicate = covered
        .iter()
        .any(|(start, end, origin)| origin != ORIGIN && *start as f64 <= midpoint && midpoint < *end as f64);
    if duplicate || text.trim().is_empty() || window.1 <= window.0 {
        return Ok(vec![]);
    }
    let latest: Option<(String, u64)> = q.exec_first(
        "SELECT text, revision FROM transcript_segments
        WHERE workspace_id = ? AND epoch_id = ? AND track = ? AND status = 'final'
          AND sample_start = ? AND sample_end = ?
        ORDER BY revision DESC LIMIT 1",
        (&fx.owner.workspace, &fx.epoch, 0, window.0, window.1),
    )?;
    if latest.as_ref().is_some_and(|(latest, _)| latest == text) {
        return Ok(vec![]);
    }
    let id = uuid();
    q.exec_drop(
        "INSERT INTO transcript_segments (id, workspace_id, epoch_id, track, sample_start, sample_end, text, status, revision, origin, provider, model,
                                             provider_connection_id, speaker_label, confidence, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'final', ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))",
        vec![
            Sql::from(&id),
            Sql::from(&fx.owner.workspace),
            Sql::from(&fx.epoch),
            Sql::from(0),
            Sql::from(window.0),
            Sql::from(window.1),
            Sql::from(text),
            Sql::from(latest.map_or(0, |(_, revision)| revision) + 1),
            Sql::from(ORIGIN),
            Sql::from("bench"),
            Sql::from("bench"),
            Sql::NULL,
            Sql::NULL,
            Sql::from(0.9),
        ],
    )?;
    Ok(vec![id])
}

/// `recordFinalWindow`: records one single-segment final window atomically, serialized per epoch.
fn record_final_window(conn: &mut mysql::PooledConn, fx: &Fixture, window: (u64, u64), text: &str) -> Outcome<Vec<Segment>> {
    let workspace = &fx.owner.workspace;
    let mut tx = conn.start_transaction(TxOpts::default())?;
    tx.exec_drop(
        "SELECT id FROM capture_epochs WHERE workspace_id = ? AND id = ? FOR UPDATE",
        (workspace, &fx.epoch),
    )?;
    let covered: Vec<(u64, u64, String)> = tx.exec(
        "SELECT sample_start, sample_end, origin FROM transcript_coverage
        WHERE workspace_id = ? AND epoch_id = ? AND track = ?
          AND sample_start < ? AND sample_end > ?
        ORDER BY sample_start",
        (workspace, &fx.epoch, 0, window.1, window.0),
    )?;
    let inserted = insert_fresh(&mut tx, fx, window, text, &covered)?;
    tx.exec_drop(
        "INSERT INTO transcript_coverage (workspace_id, epoch_id, track, sample_start, sample_end, origin, created_at)
          VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6)) AS new
          ON DUPLICATE KEY UPDATE sample_end = GREATEST(transcript_coverage.sample_end, new.sample_end)",
        (workspace, &fx.epoch, 0, window.0, window.1, ORIGIN),
    )?;
    let segments = if inserted.is_empty() {
        vec![]
    } else {
        let marks = vec!["?"; inserted.len()].join(", ");
        let params: Vec<Sql> = std::iter::once(Sql::from(workspace)).chain(inserted.iter().map(Sql::from)).collect();
        let rows: Vec<Row> = tx.exec(
            format!(
                "SELECT id, epoch_id, track, sample_start, sample_end, text, status, revision, origin, provider, model, provider_connection_id,
               speaker_label, speaker_track_id, confidence, created_at
        FROM transcript_segments s WHERE workspace_id = ? AND id IN ({marks}) ORDER BY sample_start, sample_end, revision"
            ),
            params,
        )?;
        rows.into_iter().map(segment).collect()
    };
    tx.commit()?;
    Ok(segments)
}

fn segment(row: Row) -> Segment {
    Segment {
        epoch_id: row.get("epoch_id").unwrap(),
        track: row.get("track").unwrap(),
        sample_start: row.get("sample_start").unwrap(),
        sample_end: row.get("sample_end").unwrap(),
        text: row.get("text").unwrap(),
        status: row.get("status").unwrap(),
        speaker_label: row.get("speaker_label").unwrap(),
        provider_connection_id: row.get("provider_connection_id").unwrap(),
    }
}

/// `publishFinalWindow`: records the window, then hands new segments to meeting assignment.
fn publish(fx: &Fixture, window: (u64, u64), text: &str) -> Outcome<()> {
    let mut conn = fx.pool.get_conn()?;
    let segments = record_final_window(&mut conn, fx, window, text)?;
    if !segments.is_empty() {
        on_final_segments(&mut conn, &fx.owner.workspace, &fx.listener, &segments)?;
    }
    Ok(())
}

pub fn run(job: &Value, fx: &Fixture) -> Value {
    let segments = job["segments"].as_u64().unwrap() as usize;
    let mut errors = 0;
    let run = sample(segments, 0.0, |i| {
        let window = (i as u64 * SPAN, (i as u64 + 1) * SPAN);
        count_failure(&mut errors, publish(fx, window, &text(i)));
    });
    let texts: Vec<String> = (0..segments).map(text).collect();
    let parameters = json!({ "segments": segments, "segment_seconds": 5, "segment_text_bytes": 240, "scope": "publishFinalWindow including meeting hooks" });
    let fixture_sha256 = sha256_hex(&[texts.join("\n").as_bytes()]);
    to_record(
        job,
        &run,
        RecordInput {
            workload_id: "transcript_ingest",
            phase: "steady",
            fixture_sha256,
            concurrency: 1.0,
            errors,
            checked: segments,
            dropped_samples: 0,
            parameters,
        },
    )
}
