//! `archive_streaming`: `putChunk` of server/src/recordings.ts (ownership, epoch clock, WAV shape
//! and SHA-256 validation, manifest claim, object write, commit plus reconcile job) against MySQL
//! and an in-memory object store, over the `wav-chunks-v1` fixture.

use crate::measure::{RecordInput, js_round, sample, seeded_random, sha256_hex, to_record};
use crate::store::{Access, Fixture, Outcome, count_failure, enqueue_job, fail, uuid};
use mysql::prelude::Queryable;
use mysql::{Row, TxOpts, Value as Sql};
use serde_json::{Value, json};
use std::collections::HashMap;

const RECONCILE_DELAY_MS: f64 = 60_000.0;
const CHUNK_COLUMNS: &str =
    "id, listener_id, epoch_id, track, sequence, sample_start, sample_count, sample_rate, captured_at, byte_length, sha256, object_key, committed_at";

struct Manifest<'a> {
    chunk_id: String,
    listener_id: &'a str,
    epoch_id: &'a str,
    track: u64,
    sequence: u64,
    sample_start: u64,
    sample_count: u64,
    sample_rate: u64,
    /// `captured_at` already in its DATETIME(6) encoding.
    captured_at: &'a str,
    byte_length: usize,
    sha256: &'a str,
}

/// Objects by key with their SHA-256, holding the body by reference like the TypeScript stub.
type ObjectStore<'a> = HashMap<String, (&'a [u8], String)>;

fn wav(samples: &[i16], rate: u32) -> Vec<u8> {
    let data = (samples.len() * 2) as u32;
    let mut body = Vec::with_capacity(44 + data as usize);
    body.extend_from_slice(b"RIFF");
    body.extend_from_slice(&(36 + data).to_le_bytes());
    body.extend_from_slice(b"WAVEfmt ");
    for field in [16u32.to_le_bytes(), [1, 0, 1, 0], rate.to_le_bytes(), (rate * 2).to_le_bytes(), [2, 0, 16, 0]] {
        body.extend_from_slice(&field);
    }
    body.extend_from_slice(b"data");
    body.extend_from_slice(&data.to_le_bytes());
    samples.iter().for_each(|sample| body.extend_from_slice(&sample.to_le_bytes()));
    body
}

/// Why `body` is not the canonical mono PCM16 WAV the manifest describes, or None.
fn wav_error(body: &[u8], manifest: &Manifest) -> Option<&'static str> {
    let data_bytes = manifest.sample_count * 2;
    if body.len() != manifest.byte_length || manifest.byte_length as u64 != 44 + data_bytes {
        return Some("byte_length must equal the body and 44 + 2 * sample_count");
    }
    if [&body[0..4], &body[8..16], &body[36..40]].concat() != b"RIFFWAVEfmt data" {
        return Some("not a canonical RIFF/WAVE file");
    }
    let u32_at = |at: usize| u64::from(u32::from_le_bytes(body[at..at + 4].try_into().unwrap()));
    let u16_at = |at: usize| u64::from(u16::from_le_bytes([body[at], body[at + 1]]));
    let fields = [u32_at(4), u32_at(16), u16_at(20), u16_at(22), u32_at(24), u16_at(34), u32_at(40)];
    let expected = [body.len() as u64 - 8, 16, 1, 1, manifest.sample_rate, 16, data_bytes];
    (fields != expected).then_some("expected mono PCM16 at the manifest sample rate and count")
}

/// Checks ownership, epoch clock, WAV shape and hash; returns the body's SHA-256.
fn validate(conn: &mut impl Queryable, access: &Access, listener: &str, chunk_id: &str, manifest: &Manifest, body: &[u8]) -> Outcome<String> {
    if manifest.chunk_id != chunk_id || manifest.listener_id != listener {
        return fail("manifest does not match the request path");
    }
    if !access.scopes.contains(&"capture:ingest") {
        return fail("The capture:ingest scope is required");
    }
    let epoch: Option<(u64, u64)> = conn.exec_first(
        "SELECT e.sample_rate, e.sample_start FROM capture_epochs e
        JOIN listeners l ON l.workspace_id = e.workspace_id AND l.id = e.listener_id
        WHERE e.workspace_id = ? AND e.id = ? AND l.id = ? AND l.principal_id = ?",
        (&access.workspace, manifest.epoch_id, listener, &access.principal),
    )?;
    let Some((rate, start)) = epoch else {
        return fail("Capture epoch not found for this listener");
    };
    if rate != manifest.sample_rate || manifest.sample_start < start {
        return fail("sample rate or range does not match the epoch clock");
    }
    if let Some(problem) = wav_error(body, manifest) {
        return fail(problem);
    }
    let sha256 = sha256_hex(&[body]);
    if sha256 == manifest.sha256 {
        Ok(sha256)
    } else {
        fail("sha256 does not match the body")
    }
}

fn chunk_by_id(conn: &mut impl Queryable, workspace: &str, chunk_id: &str) -> Outcome<Option<Row>> {
    Ok(conn.exec_first(
        format!("SELECT {CHUNK_COLUMNS} FROM recording_chunks WHERE workspace_id = ? AND id = ? ORDER BY sample_start"),
        (workspace, chunk_id),
    )?)
}

fn row_sha(row: &Row) -> String {
    crate::measure::hex(&row.get::<Vec<u8>, _>("sha256").unwrap())
}

/// Inserts the pending manifest row once; an overlapping chunk or other content conflicts.
fn claim(conn: &mut impl Queryable, access: &Access, manifest: &Manifest, sha256: &str) -> Outcome<Row> {
    let overlap: Vec<Row> = conn.exec(
        format!(
            "SELECT {CHUNK_COLUMNS} FROM recording_chunks WHERE (workspace_id = ? AND epoch_id = ? AND track = ? AND id <> ?
          AND (sequence = ? OR (sample_start < ? AND sample_start + sample_count > ?))) ORDER BY sample_start"
        ),
        (
            &access.workspace,
            manifest.epoch_id,
            manifest.track,
            &manifest.chunk_id,
            manifest.sequence,
            manifest.sample_start + manifest.sample_count,
            manifest.sample_start,
        ),
    )?;
    if !overlap.is_empty() {
        return fail("Another chunk already holds this sequence or source range");
    }
    let object_key = format!(
        "workspaces/{}/epochs/{}/tracks/{}/{}-{}.wav",
        access.workspace, manifest.epoch_id, manifest.track, manifest.sample_start, manifest.chunk_id
    );
    let sha_bytes: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&sha256[i * 2..i * 2 + 2], 16).unwrap()).collect();
    conn.exec_drop(
        "INSERT IGNORE INTO recording_chunks (id, workspace_id, listener_id, epoch_id, track, sequence, sample_start, sample_count, sample_rate, captured_at,
                                           byte_length, sha256, object_key, upload_state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', UTC_TIMESTAMP(6))",
        vec![
            Sql::from(&manifest.chunk_id),
            Sql::from(&access.workspace),
            Sql::from(manifest.listener_id),
            Sql::from(manifest.epoch_id),
            Sql::from(manifest.track),
            Sql::from(manifest.sequence),
            Sql::from(manifest.sample_start),
            Sql::from(manifest.sample_count),
            Sql::from(manifest.sample_rate),
            Sql::from(manifest.captured_at),
            Sql::from(manifest.byte_length),
            Sql::from(sha_bytes),
            Sql::from(object_key),
        ],
    )?;
    match chunk_by_id(conn, &access.workspace, &manifest.chunk_id)? {
        Some(row) if row_sha(&row) == sha256 => Ok(row),
        _ => fail("This chunk ID was already uploaded with different content"),
    }
}

/// Validates, stores and commits one chunk, then schedules transcript reconciliation; returns the receipt.
fn put_chunk<'a>(fx: &Fixture, store: &mut ObjectStore<'a>, chunk_id: &str, manifest: &Manifest, body: &'a [u8]) -> Outcome<Value> {
    let access = &fx.device;
    let mut conn = fx.pool.get_conn()?;
    let sha256 = validate(&mut conn, access, &fx.listener, chunk_id, manifest, body)?;
    let mut row = claim(&mut conn, access, manifest, &sha256)?;
    if row.get::<Sql, _>("committed_at") == Some(Sql::NULL) {
        let key: String = row.get("object_key").unwrap();
        if store.get(&key).is_none_or(|(_, stored)| *stored != sha256) {
            store.insert(key, (body, sha256.clone()));
        }
        let mut tx = conn.start_transaction(TxOpts::default())?;
        tx.exec_drop(
            "UPDATE recording_chunks SET upload_state = 'committed', committed_at = UTC_TIMESTAMP(6)
          WHERE workspace_id = ? AND id = ? AND upload_state = 'pending'",
            (&access.workspace, chunk_id),
        )?;
        let payload = json!({ "epoch_id": manifest.epoch_id, "track": manifest.track, "sample_start": manifest.sample_start, "sample_end": manifest.sample_start + manifest.sample_count });
        let work_key = format!("{}:{}:{}", manifest.epoch_id, manifest.track, manifest.sample_start);
        enqueue_job(
            &mut tx,
            &access.workspace,
            "transcript.reconcile",
            &work_key,
            &payload,
            Some(&access.principal),
            RECONCILE_DELAY_MS,
        )?;
        tx.commit()?;
        row = chunk_by_id(&mut conn, &access.workspace, chunk_id)?.unwrap();
    }
    let committed_at: Sql = row.get("committed_at").unwrap();
    Ok(
        json!({ "chunk_id": chunk_id, "object_key": row.get::<String, _>("object_key"), "sha256": row_sha(&row), "byte_length": row.get::<u64, _>("byte_length"), "committed_at": crate::store::datetime_text(&committed_at) }),
    )
}

pub fn run(job: &Value, fx: &Fixture) -> Value {
    let chunks = job["chunks"].as_u64().unwrap() as usize;
    let seconds = job["chunk_seconds"].as_u64().unwrap();
    let samples = 48_000 * seconds;
    let mut next = seeded_random(job["archive_seed"].as_u64().unwrap() as u32);
    let pcm: Vec<i16> = (0..samples).map(|_| js_round(next() * 32_000.0) as i16).collect();
    let body = wav(&pcm, 48_000);
    let body_sha = sha256_hex(&[&body]);
    let mut store = ObjectStore::new();
    let mut errors = 0;
    let run = sample(chunks, 0.0, |i| {
        let chunk_id = uuid();
        let manifest = Manifest {
            chunk_id: chunk_id.clone(),
            listener_id: &fx.listener,
            epoch_id: &fx.epoch,
            track: 0,
            sequence: i as u64,
            sample_start: i as u64 * samples,
            sample_count: samples,
            sample_rate: 48_000,
            captured_at: "2026-09-29 09:00:00",
            byte_length: body.len(),
            sha256: &body_sha,
        };
        count_failure(&mut errors, put_chunk(fx, &mut store, &chunk_id, &manifest, &body).map(std::hint::black_box));
    });
    let parameters = json!({ "chunks": chunks, "chunk_seconds": seconds, "object_store": "in-memory stub", "scope": "putChunk end to end against MySQL" });
    to_record(
        job,
        &run,
        RecordInput {
            workload_id: "archive_streaming",
            phase: "steady",
            fixture_sha256: body_sha.clone(),
            concurrency: 1.0,
            errors,
            checked: chunks,
            dropped_samples: 0,
            parameters,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_error_accepts_the_canonical_body_and_rejects_mismatches() {
        let body = wav(&[1, -2, 3], 48_000);
        let manifest = |sample_rate, byte_length| Manifest {
            chunk_id: "c".into(),
            listener_id: "l",
            epoch_id: "e",
            track: 0,
            sequence: 0,
            sample_start: 0,
            sample_count: 3,
            sample_rate,
            captured_at: "",
            byte_length,
            sha256: "",
        };
        assert_eq!(wav_error(&body, &manifest(48_000, 50)), None);
        assert_eq!(
            wav_error(&body, &manifest(16_000, 50)),
            Some("expected mono PCM16 at the manifest sample rate and count")
        );
        assert_eq!(
            wav_error(&body, &manifest(48_000, 52)),
            Some("byte_length must equal the body and 44 + 2 * sample_count")
        );
        let mut riff = body.clone();
        riff[0] = b'X';
        assert_eq!(wav_error(&riff, &manifest(48_000, 50)), Some("not a canonical RIFF/WAVE file"));
    }
}
