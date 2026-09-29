//! `context_read_write`: `getContextSnapshot` and `addContextItem` of server/src/context.ts at the
//! manifest's 9:1 read/write mix (authorization, per-process FIFO snapshot cache, revision check,
//! source resolution, item insert and committed-order event), on the meetings
//! `transcript_ingest` created.

use crate::measure::{RecordInput, sample, sha256_hex, to_record};
use crate::store::{Access, Fail, Fixture, Outcome, PERMISSION_REVISION, count_failure, datetime_text, fail, uuid};
use mysql::prelude::Queryable;
use mysql::{Row, Transaction, TxOpts, Value as Sql};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

const ITEM_LIMIT: usize = 200;
const CACHE_ENTRIES: usize = 500;

/// A decoded `context_items` row (`toItem`); the timed path decodes what the API returns.
#[allow(dead_code)]
pub struct Item {
    pub id: String,
    pub revision: u64,
    pub text: String,
    pub state: String,
    pub event_at: Option<String>,
    pub sources: Value,
    pub time: Value,
    pub payload_sha256: Option<String>,
}

fn json_column(row: &Row, column: &str) -> Value {
    row.get::<Option<String>, _>(column)
        .flatten()
        .map_or(Value::Null, |text| serde_json::from_str(&text).unwrap())
}

fn item(row: Row) -> Item {
    let date = |column: &str| row.get::<Sql, _>(column).filter(|value| *value != Sql::NULL).map(|value| datetime_text(&value));
    Item {
        id: row.get("id").unwrap(),
        revision: row.get("revision").unwrap(),
        text: row.get("text").unwrap(),
        state: row.get("state").unwrap(),
        event_at: date("event_at"),
        sources: json_column(&row, "sources"),
        time: json_column(&row, "time_expression"),
        payload_sha256: row
            .get::<Option<Vec<u8>>, _>("payload_sha256")
            .flatten()
            .map(|bytes| crate::measure::hex(&bytes)),
    }
}

struct Items {
    items: Vec<Item>,
    truncated: bool,
}

/// Per-process FIFO cache keyed by access and revisions, like `snapshotCache`.
#[derive(Default)]
struct SnapshotCache {
    entries: HashMap<String, Rc<Items>>,
    order: VecDeque<String>,
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    bytes
        .chunks(3)
        .flat_map(|chunk| {
            let bits = chunk.iter().enumerate().fold(0u32, |bits, (i, byte)| bits | u32::from(*byte) << (16 - 8 * i));
            (0..=chunk.len()).map(move |i| ALPHABET[(bits >> (18 - 6 * i) & 63) as usize] as char)
        })
        .collect()
}

/// `scopedCacheKey` / `encodeCursor` prefix: workspace, principal, permission revision.
fn scope_key(access: &Access, parts: Value) -> String {
    let mut scopes = access.scopes.to_vec();
    scopes.sort_unstable();
    json!([access.workspace, access.principal, PERMISSION_REVISION, scopes, { "kind": "accessible" }, parts]).to_string()
}

/// `authorizeMeeting`: workspace-visible meetings, or explicit read/write access.
fn authorize_meeting(q: &mut impl Queryable, access: &Access, meeting: &str, write: bool) -> Outcome<()> {
    let row: Option<(String, Option<String>)> = q.exec_first(
        "SELECT m.visibility, a.access FROM meetings m
      LEFT JOIN meeting_access a ON a.workspace_id = m.workspace_id AND a.meeting_id = m.id AND a.principal_id = ?
      WHERE m.workspace_id = ? AND m.id = ?",
        (&access.principal, &access.workspace, meeting),
    )?;
    let allowed = row.is_some_and(|(visibility, grant)| {
        visibility == "workspace"
            || if write {
                matches!(grant.as_deref(), Some("write" | "owner"))
            } else {
                grant.is_some()
            }
    });
    if allowed { Ok(()) } else { fail("Meeting not found") }
}

fn require_scope(access: &Access, scope: &str) -> Outcome<()> {
    if access.scopes.contains(&scope) {
        Ok(())
    } else {
        Err(Fail(format!("The {scope} scope is required")))
    }
}

fn meeting_items(q: &mut impl Queryable, workspace: &str, meeting: &str) -> Outcome<Items> {
    let rows: Vec<Row> = q.exec(
        "SELECT ci.* FROM context_items ci
        WHERE ci.workspace_id = ? AND ci.meeting_id = ? AND ci.state <> 'superseded'
          AND ci.revision = (SELECT MAX(x.revision) FROM context_items x WHERE x.id = ci.id)
        ORDER BY COALESCE(ci.event_at, ci.created_at) DESC, ci.id
        LIMIT ?",
        (workspace, meeting, ITEM_LIMIT + 1),
    )?;
    let truncated = rows.len() > ITEM_LIMIT;
    let mut items: Vec<Item> = rows.into_iter().take(ITEM_LIMIT).map(item).collect();
    items.reverse();
    Ok(Items { items, truncated })
}

/// `getContextSnapshot`: bounded, source-linked snapshot at one consistent point; returns the revision.
fn snapshot(fx: &Fixture, cache: &mut SnapshotCache, meeting: &str) -> Outcome<(u64, Value)> {
    let access = &fx.owner;
    require_scope(access, "context:read")?;
    let mut conn = fx.pool.get_conn()?;
    authorize_meeting(&mut conn, access, meeting, false)?;
    let mut tx = conn.start_transaction(TxOpts::default())?;
    let head: Option<(Sql, u64, u64, String, u64)> = tx.exec_first(
        "SELECT UTC_TIMESTAMP(6) AS now, m.context_revision, m.boundary_revision, m.timezone, w.context_seq
            FROM meetings m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = ? AND m.id = ?",
        (&access.workspace, meeting),
    )?;
    let (now, revision, boundary, timezone, seq) = head.expect("authorized meeting exists");
    let key = scope_key(access, json!(["context", meeting, revision, boundary]));
    let current = match cache.entries.get(&key) {
        Some(items) => items.clone(),
        None => Rc::new(meeting_items(&mut tx, &access.workspace, meeting)?),
    };
    if cache.entries.insert(key.clone(), current.clone()).is_none() {
        cache.order.push_back(key);
    }
    if cache.entries.len() > CACHE_ENTRIES {
        let oldest = cache.order.pop_front().unwrap();
        cache.entries.remove(&oldest);
    }
    let watermark: Option<(String, u64)> = tx.exec_first(
        "SELECT s.epoch_id, s.sample_end FROM context_processed_segments p
            JOIN transcript_segments s ON s.workspace_id = p.workspace_id AND s.id = p.segment_id
            JOIN capture_epochs e ON e.workspace_id = s.workspace_id AND e.id = s.epoch_id
            WHERE p.workspace_id = ? AND p.meeting_id = ?
            ORDER BY e.captured_at DESC, s.sample_end DESC LIMIT 1",
        (&access.workspace, meeting),
    )?;
    tx.commit()?;
    let cursor = base64url(json!([access.workspace, access.principal, PERMISSION_REVISION, seq]).to_string().as_bytes());
    let view = json!({
        "meeting_id": meeting, "revision": revision, "as_of": datetime_text(&now), "timezone": timezone,
        "source_watermark": watermark.map(|(epoch_id, sample_end)| json!({ "epoch_id": epoch_id, "sample_end": sample_end })),
        "items": current.items.len(), "changes_cursor": cursor, "truncated": current.truncated,
    });
    Ok((revision, view))
}

const SEGMENT_AT: &str =
    "DATE_ADD(e.captured_at, INTERVAL (CAST({sample} AS SIGNED) - CAST(e.sample_start AS SIGNED)) * 1000000 DIV e.sample_rate MICROSECOND)";

/// `resolveSources` for one cited segment: readable only through a visible meeting; returns
/// normalized sources and the segment's event time.
fn resolve_source(tx: &mut Transaction, access: &Access, segment_id: &str) -> Outcome<(Value, Option<String>)> {
    let visible: Vec<String> = tx.exec(
        "SELECT m.id FROM meetings m WHERE m.workspace_id = ? AND (m.visibility = 'workspace' OR EXISTS (SELECT 1 FROM meeting_access a
            WHERE a.workspace_id = m.workspace_id AND a.meeting_id = m.id AND a.principal_id = ?)) ORDER BY m.id",
        (&access.workspace, &access.principal),
    )?;
    let at = |sample: &str| SEGMENT_AT.replace("{sample}", sample);
    let rows: Vec<Row> = tx.exec(
        format!(
            "SELECT s.id, m.id AS meeting_id, s.epoch_id, s.track, s.sample_start, s.sample_end, s.text, s.status, s.revision,
          s.origin, s.provider, s.model, s.provider_connection_id, s.speaker_label, s.speaker_track_id, s.confidence, s.created_at,
          {} AS event_at,
          GREATEST(0, TIMESTAMPDIFF(MICROSECOND, m.started_at, {}) DIV 1000) AS start_ms,
          GREATEST(0, TIMESTAMPDIFF(MICROSECOND, m.started_at, {}) DIV 1000) AS end_ms
        FROM transcript_segments s
        JOIN capture_epochs e ON e.workspace_id = s.workspace_id AND e.id = s.epoch_id
        JOIN meeting_ranges r ON r.workspace_id = s.workspace_id AND r.epoch_id = s.epoch_id AND r.track = s.track
          AND s.sample_start >= r.sample_start AND s.sample_start < r.sample_end
        JOIN meetings m ON m.workspace_id = r.workspace_id AND m.id = r.meeting_id AND m.boundary_revision = r.boundary_revision
        WHERE s.workspace_id = ? AND s.status = 'final' AND s.id IN (?)
        ORDER BY e.captured_at, s.sample_start, s.id
        LIMIT ?",
            at("s.sample_start"),
            at("s.sample_start"),
            at("s.sample_end")
        ),
        (&access.workspace, segment_id, 1000),
    )?;
    let Some(row) = rows.into_iter().find(|row| visible.contains(&row.get::<String, _>("meeting_id").unwrap())) else {
        return fail("Cited source not found");
    };
    let sources = json!([{ "segment_id": row.get::<String, _>("id"), "start_ms": row.get::<i64, _>("start_ms"), "end_ms": row.get::<i64, _>("end_ms") }]);
    Ok((sources, Some(datetime_text(&row.get::<Sql, _>("event_at").unwrap()))))
}

/// `writeItem` plus `appendContextEvent` inside the caller's transaction.
fn write_item(
    tx: &mut Transaction,
    access: &Access,
    meeting: &str,
    text: &str,
    cited: (Value, Option<String>),
    idempotency: (&str, &str),
    source_revision: u64,
) -> Outcome<Item> {
    let id = uuid();
    let sha: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&idempotency.1[i * 2..i * 2 + 2], 16).unwrap()).collect();
    tx.exec_drop(
        "INSERT INTO context_items (id, revision, workspace_id, meeting_id, kind, text, state, derivation, event_at, valid_from, valid_until,
        time_expression, sources, author_type, author_principal_id, supersedes_id, supersedes_revision, idempotency_key, payload_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))",
        vec![
            Sql::from(&id),
            Sql::from(1),
            Sql::from(&access.workspace),
            Sql::from(meeting),
            Sql::from("decision"),
            Sql::from(text),
            Sql::from("provisional"),
            Sql::from("human_correction"),
            Sql::from(cited.1),
            Sql::NULL,
            Sql::NULL,
            Sql::NULL,
            Sql::from(cited.0.to_string()),
            Sql::from("human"),
            Sql::from(&access.principal),
            Sql::NULL,
            Sql::NULL,
            Sql::from(idempotency.0),
            Sql::from(sha),
        ],
    )?;
    tx.exec_drop(
        "UPDATE meetings SET context_revision = context_revision + 1 WHERE workspace_id = ? AND id = ?",
        (&access.workspace, meeting),
    )?;
    tx.exec_drop(
        "UPDATE workspaces SET `context_seq` = LAST_INSERT_ID(`context_seq` + 1) WHERE id = ?",
        (&access.workspace,),
    )?;
    if tx.affected_rows() != 1 {
        return fail("Unknown workspace");
    }
    let seq = tx.last_insert_id().unwrap_or(0);
    tx.exec_drop(
        "INSERT INTO context_events (workspace_id, seq, meeting_id, item_id, item_revision, change_kind, actor_principal_id, source_revision, permission_revision, created_at)
      SELECT id, ?, ?, ?, ?, ?, ?, ?, permission_revision, UTC_TIMESTAMP(6)
      FROM workspaces WHERE id = ?",
        vec![Sql::from(seq), Sql::from(meeting), Sql::from(&id), Sql::from(1), Sql::from("item_added"), Sql::from(&access.principal), Sql::from(source_revision), Sql::from(&access.workspace)],
    )?;
    let row: Option<Row> = tx.exec_first("SELECT * FROM context_items WHERE id = ? AND revision = ?", (&id, 1))?;
    Ok(item(row.unwrap()))
}

/// `addContextItem` citing one segment; returns the new (or replayed) item.
fn add_item(fx: &Fixture, meeting: &str, expected_revision: u64, text: &str, segment_id: &str, key: &str) -> Outcome<Item> {
    let access = &fx.owner;
    require_scope(access, "context:write")?;
    let mut conn = fx.pool.get_conn()?;
    authorize_meeting(&mut conn, access, meeting, true)?;
    let sources = json!([{ "segment_id": segment_id, "start_ms": 0, "end_ms": 1_000 }]);
    let payload = sha256_hex(&[json!(["add", meeting, "decision", text, sources]).to_string().as_bytes()]);
    let mut tx = conn.start_transaction(TxOpts::default())?;
    let lock: Option<(u64, u64)> = tx.exec_first(
        "SELECT context_revision, boundary_revision FROM meetings WHERE workspace_id = ? AND id = ? FOR UPDATE",
        (&access.workspace, meeting),
    )?;
    let (revision, boundary) = lock.expect("authorized meeting exists");
    let previous: Option<Row> = tx.exec_first(
        "SELECT * FROM context_items WHERE workspace_id = ? AND author_principal_id = ? AND idempotency_key = ?",
        (&access.workspace, &access.principal, key),
    )?;
    if let Some(previous) = previous.map(item) {
        return if previous.payload_sha256.as_deref() == Some(payload.as_str()) {
            Ok(previous)
        } else {
            fail("Idempotency key reused with different content")
        };
    }
    if revision != expected_revision {
        return fail("Context changed since expected_revision");
    }
    let cited = resolve_source(&mut tx, access, segment_id)?;
    let written = write_item(&mut tx, access, meeting, text, cited, (key, &payload), boundary)?;
    tx.commit()?;
    Ok(written)
}

/// One cited final segment per meeting (the earliest), granting the owner explicit access, as
/// `citedSegments` in scripts/benchmark.ts does outside the timed region.
fn cited_segments(fx: &Fixture) -> Outcome<Vec<(String, String, u64)>> {
    let mut conn = fx.pool.get_conn()?;
    let rows: Vec<(String, String, u64)> = conn.exec(
        "SELECT r.meeting_id, s.id AS segment_id, s.sample_start FROM transcript_segments s
            JOIN meeting_ranges r ON r.epoch_id = s.epoch_id AND s.sample_start >= r.sample_start AND s.sample_start < r.sample_end
            JOIN meetings m ON m.id = r.meeting_id AND m.boundary_revision = r.boundary_revision
            ORDER BY m.started_at, r.meeting_id, s.sample_start",
        (),
    )?;
    conn.exec_drop(
        "INSERT IGNORE INTO meeting_access (workspace_id, meeting_id, principal_id, access, granted_by, created_at)
            SELECT workspace_id, id, ?, 'owner', ?, UTC_TIMESTAMP(6) FROM meetings WHERE workspace_id = ?",
        (&fx.owner.principal, &fx.owner.principal, &fx.owner.workspace),
    )?;
    let mut cited = rows;
    cited.dedup_by(|later, first| later.0 == first.0);
    Ok(cited)
}

pub fn run(job: &Value, fx: &Fixture) -> Value {
    let operations = job["operations"].as_u64().unwrap() as usize;
    let cited = cited_segments(fx).expect("cited segments");
    assert!(!cited.is_empty(), "context_read_write needs transcript_ingest to create meetings first");
    let mut cache = SnapshotCache::default();
    let mut errors = 0;
    let run = sample(operations, 0.0, |i| {
        let (meeting, segment, _) = &cited[i % cited.len()];
        let outcome = snapshot(fx, &mut cache, meeting).and_then(|(revision, view)| {
            std::hint::black_box(view);
            if i % 10 != 9 {
                Ok(())
            } else {
                add_item(fx, meeting, revision, &format!("Decision {i}"), segment, &format!("bench-{i}")).map(|written| drop(std::hint::black_box(written)))
            }
        });
        count_failure(&mut errors, outcome);
    });
    let starts: Vec<String> = cited.iter().map(|(_, _, start)| start.to_string()).collect();
    let parameters = json!({ "operations": operations, "meetings": cited.len(), "read_write_ratio": 9 });
    let fixture_sha256 = sha256_hex(&[starts.join("\n").as_bytes()]);
    to_record(
        job,
        &run,
        RecordInput {
            workload_id: "context_read_write",
            phase: "steady",
            fixture_sha256,
            concurrency: 1.0,
            errors,
            checked: operations,
            dropped_samples: 0,
            parameters,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_matches_node_without_padding() {
        assert_eq!(base64url(b"[\"w\",1]"), "WyJ3IiwxXQ");
        assert_eq!(base64url(b"ab"), "YWI");
        assert_eq!(base64url(b"abc"), "YWJj");
    }
}
