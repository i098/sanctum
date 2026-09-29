//! Measurement shared by every workload, mirroring benchmarks/measure.ts: the mulberry32 fixture
//! generator, a sampler timing each operation (from its scheduled arrival under an offered rate)
//! with CPU, peak RSS and live heap, and the `benchmarks/result-format.ts` record.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// Counts live heap bytes so records can report `heap` like V8's `heapUsed`.
struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LIVE.fetch_add(layout.size(), Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// mulberry32 with the exact integer semantics of `seededRandom`: uniform values in [-0.5, 0.5).
pub fn seeded_random(seed: u32) -> impl FnMut() -> f64 {
    let mut state = seed;
    move || {
        state = state.wrapping_add(0x6d2b_79f5);
        let mut t = (state ^ (state >> 15)).wrapping_mul(1 | state);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0 - 0.5
    }
}

/// JavaScript `Math.round`: halves round toward positive infinity.
pub fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

pub fn sha256_hex(parts: &[&[u8]]) -> String {
    let mut hash = Sha256::new();
    parts.iter().for_each(|part| hash.update(part));
    hex(&hash.finalize())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn rss_bytes() -> f64 {
    let statm = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
    let pages: f64 = statm.split_whitespace().nth(1).and_then(|field| field.parse().ok()).unwrap_or(0.0);
    pages * unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as f64
}

fn cpu_ms() -> f64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    let ms = |time: libc::timeval| time.tv_sec as f64 * 1000.0 + time.tv_usec as f64 / 1000.0;
    ms(usage.ru_utime) + ms(usage.ru_stime)
}

pub struct Sample {
    latencies: Vec<f64>,
    wall_ms: f64,
    cpu_ms: f64,
    peak_rss: f64,
    peak_heap: f64,
    rss_series: Vec<f64>,
}

/// Runs `op` for i = 0..count-1 sequentially. With `rate` > 0, operation i is due at i/rate
/// seconds; a late operation's latency counts from its due time, and the loop sleeps only when
/// at least 1 ms ahead, exactly as `sample` in benchmarks/measure.ts.
pub fn sample(count: usize, rate: f64, mut op: impl FnMut(usize)) -> Sample {
    let mut run = Sample {
        latencies: Vec::with_capacity(count),
        wall_ms: 0.0,
        cpu_ms: 0.0,
        peak_rss: 0.0,
        peak_heap: 0.0,
        rss_series: vec![],
    };
    let cpu = cpu_ms();
    let started = Instant::now();
    let mut next_series = 0.0;
    for i in 0..count {
        let now = started.elapsed().as_secs_f64() * 1000.0;
        let due = if rate > 0.0 { i as f64 * 1000.0 / rate } else { now };
        if due - now >= 1.0 {
            std::thread::sleep(Duration::from_secs_f64((due - now) / 1000.0));
        }
        let begin = due.min(started.elapsed().as_secs_f64() * 1000.0);
        op(i);
        let end = started.elapsed().as_secs_f64() * 1000.0;
        run.latencies.push(end - begin);
        if i % 64 == 0 {
            run.peak_rss = run.peak_rss.max(rss_bytes());
            run.peak_heap = run.peak_heap.max(LIVE.load(Ordering::Relaxed) as f64);
        }
        if end >= next_series {
            run.rss_series.push(rss_bytes());
            next_series = end + 1000.0;
        }
    }
    run.wall_ms = started.elapsed().as_secs_f64() * 1000.0;
    run.cpu_ms = cpu_ms() - cpu;
    run
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let at = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted.get(at.saturating_sub(1).min(sorted.len().saturating_sub(1))).copied().unwrap_or(0.0)
}

pub struct RecordInput<'a> {
    pub workload_id: &'a str,
    pub phase: &'a str,
    pub fixture_sha256: String,
    pub concurrency: f64,
    pub errors: usize,
    pub checked: usize,
    pub dropped_samples: usize,
    pub parameters: Value,
}

/// One record in the `result-format.ts` shape; `verified` stays false (no controlled host).
pub fn to_record(job: &Value, run: &Sample, input: RecordInput) -> Value {
    let mut sorted = run.latencies.clone();
    sorted.sort_by(f64::total_cmp);
    let mut parameters = input.parameters;
    parameters["not_applicable_metrics"] = json!(["external", "gc_ms", "event_loop_delay_p99"]);
    if run.rss_series.len() > 1 {
        parameters["rss_series_bytes"] = json!(run.rss_series);
    }
    json!({
        "workload_id": input.workload_id,
        "implementation": "rust",
        "git_sha": job["git_sha"],
        "fixture_sha256": input.fixture_sha256,
        "started_at": job["started_at"],
        "host": null,
        "phase": input.phase,
        "repetitions": run.latencies.len(),
        "offered_load": { "per_second": job["rate"].as_f64().unwrap_or(0.0), "concurrency": input.concurrency },
        "metrics": {
            "throughput": run.latencies.len() as f64 / (run.wall_ms / 1000.0),
            "latency_p50": percentile(&sorted, 50.0),
            "latency_p95": percentile(&sorted, 95.0),
            "latency_p99": percentile(&sorted, 99.0),
            "error_rate": if input.checked == 0 { 0.0 } else { input.errors as f64 / input.checked as f64 },
            "dropped_samples": input.dropped_samples,
            "cpu": 100.0 * run.cpu_ms / run.wall_ms,
            "rss": run.peak_rss,
            "heap": run.peak_heap,
            "external": 0,
            "gc_ms": 0,
            "event_loop_delay_p99": 0,
        },
        "correctness": { "errors": input.errors, "dropped_samples": input.dropped_samples },
        "verified": false,
        "parameters": parameters,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mulberry32_matches_the_typescript_generator() {
        // seededRandom(1) in benchmarks/measure.ts yields these first values.
        let mut next = seeded_random(1);
        let values: Vec<f64> = (0..3).map(|_| next()).collect();
        assert_eq!(values, vec![0.12707394058816135, -0.4972642788197845, 0.027447039959952235]);
    }

    #[test]
    fn js_round_rounds_halves_up() {
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(2.5), 3.0);
    }

    #[test]
    fn percentile_uses_the_nearest_rank() {
        let sorted: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(percentile(&sorted, 50.0), 50.0);
        assert_eq!(percentile(&sorted, 99.0), 99.0);
        assert_eq!(percentile(&[], 99.0), 0.0);
    }
}
