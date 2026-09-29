//! Shared database pieces of the MySQL workloads: the seeded fixture the runner created, access
//! scopes, failure type, the job-ledger enqueue of server/src/jobs.ts and DATETIME(6) helpers.

use mysql::prelude::Queryable;
use mysql::{Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, Value as Sql};
use serde_json::Value;

/// A failed operation: counted by the workload, never retried or hidden.
#[derive(Debug)]
pub struct Fail(pub String);

impl From<mysql::Error> for Fail {
    fn from(error: mysql::Error) -> Self {
        Fail(error.to_string())
    }
}

pub type Outcome<T> = Result<T, Fail>;

pub fn fail<T>(message: &str) -> Outcome<T> {
    Err(Fail(message.to_string()))
}

/// Counts a failed operation and reports why on stderr (stdout carries only records).
pub fn count_failure<T>(errors: &mut usize, outcome: Outcome<T>) {
    if let Err(Fail(message)) = outcome {
        *errors += 1;
        eprintln!("operation failed: {message}");
    }
}

/// The subset of `AccessScope` these paths read; every principal has `meetings: accessible` and
/// permission revision 1, as `access` in scripts/benchmark.ts builds them.
pub struct Access {
    pub workspace: String,
    pub principal: String,
    pub scopes: &'static [&'static str],
}

pub const PERMISSION_REVISION: u64 = 1;

pub struct Fixture {
    pub pool: Pool,
    pub owner: Access,
    pub device: Access,
    pub listener: String,
    pub epoch: String,
}

/// Attaches to the database the runner created with `createDatabase`, with the same pool bound
/// (8 connections) as `attachDatabase`.
pub fn fixture(job: &Value) -> Fixture {
    let ids = &job["ids"];
    let id = |key: &str| ids[key].as_str().unwrap().to_string();
    let opts = OptsBuilder::from_opts(Opts::from_url(job["database_url"].as_str().unwrap()).unwrap())
        .pool_opts(PoolOpts::default().with_constraints(PoolConstraints::new(1, 8).unwrap()));
    Fixture {
        pool: Pool::new(opts).expect("benchmark database"),
        owner: Access {
            workspace: id("workspace"),
            principal: id("owner"),
            scopes: &["context:read", "context:write", "recordings:read"],
        },
        device: Access {
            workspace: id("workspace"),
            principal: id("device"),
            scopes: &["capture:ingest"],
        },
        listener: id("listener"),
        epoch: id("epoch"),
    }
}

pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `enqueueJob`: joins the caller's transaction, re-arms an active row with the same work key.
pub fn enqueue_job(
    q: &mut impl Queryable,
    workspace: &str,
    kind: &str,
    work_key: &str,
    payload: &Value,
    requested_by: Option<&str>,
    delay_ms: f64,
) -> Outcome<String> {
    q.exec_drop(
        "INSERT INTO jobs (id, workspace_id, kind, work_key, requested_by, source_revision, status, payload, available_at, max_attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, UTC_TIMESTAMP(6) + INTERVAL ? MICROSECOND, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)) AS new
      ON DUPLICATE KEY UPDATE
        rearmed = IF(jobs.status = 'running', 1, jobs.rearmed),
        attempts = IF(jobs.status = 'running', jobs.attempts, 0),
        available_at = IF(?, LEAST(jobs.available_at, new.available_at), GREATEST(jobs.available_at, new.available_at)),
        payload = new.payload,
        requested_by = new.requested_by,
        source_revision = COALESCE(new.source_revision, jobs.source_revision),
        max_attempts = new.max_attempts,
        updated_at = new.updated_at",
        (uuid(), workspace, kind, work_key, requested_by, Sql::NULL, payload.to_string(), (delay_ms * 1000.0).round() as i64, 5, false),
    )?;
    let id: Option<String> = q.exec_first(
        "SELECT id FROM jobs WHERE workspace_id = ? AND kind = ? AND active_work_key = ?",
        (workspace, kind, work_key),
    )?;
    id.map_or_else(|| fail("job row missing after enqueue"), Ok)
}

// Howard Hinnant's civil-calendar conversions, for UTC DATETIME(6) <-> epoch milliseconds.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// Epoch milliseconds of a DATETIME value, truncated to the millisecond like `Date.parse`.
pub fn datetime_ms(value: &Sql) -> f64 {
    match value {
        Sql::Date(y, mo, d, h, mi, s, us) => {
            let days = days_from_civil(i64::from(*y), i64::from(*mo), i64::from(*d));
            ((days * 86_400 + i64::from(*h) * 3600 + i64::from(*mi) * 60 + i64::from(*s)) * 1000 + i64::from(*us / 1000)) as f64
        }
        other => panic!("expected DATETIME, got {other:?}"),
    }
}

/// `YYYY-MM-DD HH:MM:SS.ffffff`, the `DbUtc` encoding of a DATETIME(6) value.
pub fn datetime_text(value: &Sql) -> String {
    match value {
        Sql::Date(y, mo, d, h, mi, s, us) => format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}"),
        other => panic!("expected DATETIME, got {other:?}"),
    }
}

/// `dbTime`: the DATETIME(6) parameter for a millisecond instant (`toISOString` precision).
pub fn db_time(ms: f64) -> String {
    let ms = ms.trunc() as i64;
    let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let (y, mo, d) = civil_from_days(days);
    format!(
        "{y:04}-{mo:02}-{d:02} {:02}:{:02}:{:02}.{:03}",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn datetime_round_trips_through_epoch_milliseconds() {
        let value = Sql::Date(2026, 9, 29, 9, 0, 0, 123_456);
        assert_eq!(datetime_ms(&value), 1_790_672_400_123.0);
        assert_eq!(db_time(1_790_672_400_123.9), "2026-09-29 09:00:00.123");
        assert_eq!(datetime_text(&value), "2026-09-29 09:00:00.123456");
        assert_eq!(db_time(951_782_400_000.0), "2000-02-29 00:00:00.000");
    }
}
