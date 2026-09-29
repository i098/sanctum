# Benchmarks

`workload.json` is the machine-readable workload manifest required by `tasks/plan.md` section 04.
It names the five matched workloads: `pcm_ingest`, `transcript_ingest`, `context_read_write`, `archive_streaming` and `cosine_ranking`.
Each workload declares its deterministic fixture generator and seed, parameters, metrics, durability semantics and parity gate.

`result-format.ts` defines the per-run result record and validates both files with `validateManifest` and `validateResult`.
One result covers one workload, one implementation (`typescript` or `rust`), one phase (`cold` or `steady`) and one offered load.
It records the git SHA, fixture SHA-256, start time, host, repetitions, metrics, correctness counts and `verified`.
`host` must equal the manifest `reference_hardware.name`.
`verified: true` is invalid while the manifest hardware status is `unverified`.
Parity gates may be stricter than the plan tolerance (90% of Rust throughput, 110% of Rust p95/p99 latency), never looser.

## Status

No controlled benchmark host is configured, so hardware, runtime and limit fields are `null` and marked `unverified`.
That missing configuration is an explicit unrun gate, not a pass.
No benchmark result exists yet and TypeScript/Rust parity is unverified.
The fixture generators and the benchmark harness land with T04 (matching) and T26 (validation); until then CI only validates the manifest shape through `npm run check:app`.
