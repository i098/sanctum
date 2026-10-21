//! Measurement shared by every workload, mirroring benchmarks/measure.ts: the mulberry32 fixture
//! generator, a sampler timing each operation (from its scheduled arrival under an offered rate)
//! with CPU, peak RSS and live heap, and the `benchmarks/result-format.ts` record.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Barrier, Mutex, OnceLock};
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

/// Process-wide observations of one phase, shared by all its clients so CPU and memory are
/// measured once, never per client.
struct Probe {
    started: OnceLock<Instant>,
    /// Bits of the f64 millisecond mark after which the next RSS series point is due.
    next_series_ms: AtomicU64,
    peak_rss: AtomicU64,
    peak_heap: AtomicUsize,
    rss_series: Mutex<Vec<f64>>,
}

impl Probe {
    fn new() -> Self {
        Probe {
            started: OnceLock::new(),
            next_series_ms: AtomicU64::new(0),
            peak_rss: AtomicU64::new(0),
            peak_heap: AtomicUsize::new(0),
            rss_series: Mutex::new(vec![]),
        }
    }

    fn finish(self, latencies: Vec<f64>, cpu_before: f64) -> Sample {
        let wall_ms = self.started.get().map_or(0.0, |started| started.elapsed().as_secs_f64() * 1000.0);
        Sample {
            latencies,
            wall_ms,
            cpu_ms: cpu_ms() - cpu_before,
            peak_rss: self.peak_rss.into_inner() as f64,
            peak_heap: self.peak_heap.into_inner() as f64,
            rss_series: self.rss_series.into_inner().unwrap(),
        }
    }
}

/// One client's ordered loop over i = 0..count-1. With `rate` > 0, operation i is due at i/rate
/// seconds; a late operation's latency counts from its due time, and the loop sleeps only when
/// at least 1 ms ahead, exactly as `sample` in benchmarks/measure.ts. The phase clock starts at
/// the first client to arrive.
fn run_client(probe: &Probe, count: usize, rate: f64, mut op: impl FnMut(usize)) -> Vec<f64> {
    let started = *probe.started.get_or_init(Instant::now);
    let mut latencies = Vec::with_capacity(count);
    for i in 0..count {
        let now = started.elapsed().as_secs_f64() * 1000.0;
        let due = if rate > 0.0 { i as f64 * 1000.0 / rate } else { now };
        if due - now >= 1.0 {
            std::thread::sleep(Duration::from_secs_f64((due - now) / 1000.0));
        }
        let begin = due.min(started.elapsed().as_secs_f64() * 1000.0);
        op(i);
        let end = started.elapsed().as_secs_f64() * 1000.0;
        latencies.push(end - begin);
        if i % 64 == 0 {
            probe.peak_rss.fetch_max(rss_bytes() as u64, Ordering::Relaxed);
            probe.peak_heap.fetch_max(LIVE.load(Ordering::Relaxed), Ordering::Relaxed);
        }
        let due_series = probe.next_series_ms.load(Ordering::Relaxed);
        if end >= f64::from_bits(due_series)
            && probe
                .next_series_ms
                .compare_exchange(due_series, (end + 1000.0).to_bits(), Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
        {
            probe.rss_series.lock().unwrap().push(rss_bytes());
        }
    }
    latencies
}

/// Runs `op` for i = 0..count-1 sequentially on the calling thread.
pub fn sample(count: usize, rate: f64, op: impl FnMut(usize)) -> Sample {
    let probe = Probe::new();
    let cpu = cpu_ms();
    let latencies = run_client(&probe, count, rate, op);
    probe.finish(latencies, cpu)
}

/// Runs `op(client, i)` for i = 0..count-1 on one thread per client, all released together by a
/// barrier so the clients overlap for the whole phase; each client's operations stay ordered.
/// Latencies are pooled across clients, wall time, CPU and memory are the one process-wide
/// observation, and a panicking client panics the phase instead of yielding a sample.
pub fn sample_clients<C: Send>(clients: &mut [C], count: usize, op: impl Fn(&mut C, usize) + Sync) -> Sample {
    let probe = Probe::new();
    let cpu = cpu_ms();
    let barrier = Barrier::new(clients.len());
    let latencies = std::thread::scope(|scope| {
        let (probe, barrier, op) = (&probe, &barrier, &op);
        let threads: Vec<_> = clients
            .iter_mut()
            .map(|client| {
                scope.spawn(move || {
                    barrier.wait();
                    run_client(probe, count, 0.0, |i| op(client, i))
                })
            })
            .collect();
        threads
            .into_iter()
            .flat_map(|thread| thread.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic)))
            .collect()
    });
    probe.finish(latencies, cpu)
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
    fn clients_overlap_and_their_operations_are_pooled() {
        // Each client's first operation waits for every client: a sequential run would never return.
        let meeting = Barrier::new(3);
        let mut clients = vec![0usize; 3];
        let run = sample_clients(&mut clients, 4, |done, i| {
            if i == 0 {
                meeting.wait();
            }
            *done += 1;
        });
        assert_eq!(clients, [4, 4, 4]);
        assert_eq!(run.latencies.len(), 12);
    }

    #[test]
    #[should_panic(expected = "client 1 failed")]
    fn a_failing_client_fails_the_phase() {
        let mut clients = vec![0usize, 1];
        sample_clients(&mut clients, 3, |client, i| assert!(!(*client == 1 && i == 1), "client 1 failed"));
    }

    #[test]
    fn record_percentiles_come_from_the_pooled_latencies() {
        // Clients with 90 and 10 operations: per-client p50s are 45 and 95 (mean 70); pooled p50 is 50.
        let run = Sample {
            latencies: (1..=90).chain(91..=100).map(f64::from).collect(),
            wall_ms: 1000.0,
            cpu_ms: 0.0,
            peak_rss: 0.0,
            peak_heap: 0.0,
            rss_series: vec![],
        };
        let input = RecordInput {
            workload_id: "w",
            phase: "steady",
            fixture_sha256: String::new(),
            concurrency: 2.0,
            errors: 3,
            checked: 100,
            dropped_samples: 0,
            parameters: json!({}),
        };
        let record = to_record(&json!({}), &run, input);
        assert_eq!(record["metrics"]["latency_p50"], 50.0);
        assert_eq!(record["metrics"]["latency_p99"], 99.0);
        assert_eq!(record["metrics"]["throughput"], 100.0);
        assert_eq!(record["metrics"]["error_rate"], 0.03);
        assert_eq!(record["offered_load"]["concurrency"], 2.0);
    }

    #[test]
    fn percentile_uses_the_nearest_rank() {
        let sorted: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(percentile(&sorted, 50.0), 50.0);
        assert_eq!(percentile(&sorted, 99.0), 99.0);
        assert_eq!(percentile(&[], 99.0), 0.0);
    }
}
