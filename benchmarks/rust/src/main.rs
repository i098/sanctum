//! Benchmark-only Rust reference for the five workloads in benchmarks/workload.json (plan section
//! 04). It is never an application dependency. scripts/benchmark-compare.ts builds it, passes the
//! same job JSON it passes to `node scripts/benchmark.ts --job`, and reads one result record
//! (benchmarks/result-format.ts shape, `implementation: "rust"`) per stdout line.
//!
//! Usage: sanctum-bench '<job json>'

mod archive;
mod boundaries;
mod context;
mod cosine;
mod measure;
mod meetings;
mod pcm;
mod store;
mod transcripts;

fn main() {
    let job: serde_json::Value = serde_json::from_str(&std::env::args().nth(1).expect("usage: sanctum-bench '<job json>'")).expect("job must be JSON");
    let records = match job["workload"].as_str() {
        Some("pcm_ingest") => pcm::run(&job),
        Some("cosine_ranking") => cosine::run(&job),
        // The MySQL workloads share each client's database in this order: context cites transcript meetings.
        Some("database") => {
            let fixtures = store::fixtures(&job);
            vec![archive::run(&job, &fixtures), transcripts::run(&job, &fixtures), context::run(&job, &fixtures)]
        }
        other => panic!("unknown workload {other:?}"),
    };
    records.iter().for_each(|record| println!("{record}"));
}
