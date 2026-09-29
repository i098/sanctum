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

## TypeScript harness

`node scripts/benchmark.ts [--smoke] [--mysql-url mysql://...] [--out file.jsonl]` (`npm run benchmark`) runs the TypeScript side of every workload through the real application code:

| Workload | Timed operation | Scope note |
| --- | --- | --- |
| `pcm_ingest` | `decodePcmFrame` plus dispatch into a bounded 256-frame queue | Frame validation and dispatch only; socket, auth and ASR excluded. |
| `archive_streaming` | `putChunk`: WAV shape, SHA-256, manifest claim, object write, commit | In-memory object store with the production interface; real MySQL. |
| `transcript_ingest` | `publishFinalWindow`: segments, coverage and meeting hooks | Real MySQL. |
| `context_read_write` | `getContextSnapshot` and `addContextItem`, 9 reads per write | Real MySQL; cites the earliest segment of each meeting `transcript_ingest` created. |
| `cosine_ranking` | Exact float32 top-k (`scripts/benchmark-matching.ts`) | In-process, verified against a full-sort reference. |

The MySQL workloads create and drop a `sanctum_bench_*` database; without a URL they are reported as unrun.
`npm run check:app` runs `--smoke` as a correctness check: a failed operation or invalid record fails the step, timings never do.

## Rust reference

`rust/` is a benchmark-only Rust port of the same five workloads over the same fixtures.
It is not an npm workspace, not built by any application image and never an application dependency.
It uses the `mysql` crate with server-side prepared statements, as `@effect/sql-mysql2` does through mysql2 `execute`.

| Workload | Port | Differences |
| --- | --- | --- |
| `pcm_ingest` | Same header checks and error names, borrowed payload, 256-frame queue drained every 32 frames | No event loop, so no yield every 32 frames. |
| `cosine_ranking` | Same f64 accumulation over f32 values, sorted-insertion top-k, 1,000-row batches and full-sort check | No yield between batches. |
| `archive_streaming` | `putChunk`: the same SQL statements, WAV and hash checks, idempotent claim, commit and reconcile job | The in-memory object store holds the body by reference, like the TypeScript stub. |
| `transcript_ingest` | `recordFinalWindow` and `onFinalSegments`: the same SQL, boundary evaluation, claim, promotion and seal logic | Only the listener capture key and a seal without a capture watermark; the fixture uses neither a capture group nor a capture end. |
| `context_read_write` | `getContextSnapshot` and `addContextItem`: authorization, the 500-entry FIFO snapshot cache, revision and idempotency checks, source resolution and the committed-order event | None in behavior. |

Both implementations run one operation at a time on one thread, as the Node.js event loop does.
Rust `heap` is the live byte count of a counting global allocator; `external`, `gc_ms` and `event_loop_delay_p99` do not apply and are reported as 0 and listed in `not_applicable_metrics`.
`cargo test --release --manifest-path benchmarks/rust/Cargo.toml` checks the fixture generator against the TypeScript values, frame validation, top-k tie order, boundary cues, WAV validation and date arithmetic.

## Matched runner

`node scripts/benchmark-compare.ts [--smoke] [--mysql-url mysql://...] [--out file.jsonl] [--soak-seconds 300]` needs `cargo` on `PATH` (for example `PATH=$HOME/.cargo/bin:$PATH`).
It builds `rust/` with `cargo build --release --locked` and passes one job JSON to `node scripts/benchmark.ts --job` and to the Rust binary, each in its own process.
It runs three modes:

- `closed_loop`: `pcm_ingest`, `cosine_ranking` and the three MySQL workloads at the TypeScript harness scale; each implementation gets a fresh seeded database.
- `open_loop_sweep`: `pcm_ingest` at the manifest's offered frame rates, then doubling, for 2 s per rate until achieved throughput falls below 95% of the offered rate.
- `long_run`: `pcm_ingest` at 3,200 frames/s for `--soak-seconds`; RSS growth from the end of a 10% warm-up to the end must stay within 16 MiB.

Every open-loop run is one sequential stream of frames, so its records carry `offered_load.concurrency: 1`.
The listener count a rate models at 50 frames/s per listener (64 at 3,200 frames/s) is `parameters.equivalent_listeners_at_50fps`; no run drives concurrent listeners.

Open-loop latency counts from each frame's scheduled arrival, so a stall cannot hide tail latency; the driver sleeps only when at least 1 ms ahead.
The runner fails when a record is invalid, an operation fails, the two implementations' fixture SHA-256s differ, their MySQL end states differ, or a long run exceeds its bound.
The MySQL end state is compared through row counts and content sums of every written table, excluding IDs and wall-clock times.
Every record carries the host description, the runtime and the SHA-256 of its implementation's tracked source files in `parameters.harness`.
Comparative timing stays out of ordinary CI: `npm run check` covers the runner's decision logic and open-loop pacing, not the Rust build or any timing gate.

## Results

Both result files come from uncontrolled hosts: they are not reference-hardware measurements and support no capacity, budget or parity claim.

[results/typescript-52866cd-local.jsonl](results/typescript-52866cd-local.jsonl) holds one full-scale TypeScript-only run at commit `52866cd` (SHA-256 `a3c9a570f5cc641f09d23aeebaf6108c23f6efeccf3be91df461352ba54111e1`).

[results/rust-vs-typescript-c24a695-uncontrolled.jsonl](results/rust-vs-typescript-c24a695-uncontrolled.jsonl) holds one matched run of both implementations at commit `c24a695` (file SHA-256 `01add9d9e34fa688ded47ad95f471b71208a25aa8d0e6c70b75356cab632b782`): 38 records, zero failed operations.
Commits after `c24a695` change only documentation.
An earlier run at `bf12035` was withdrawn because its open-loop records gave the modelled listener count as `offered_load.concurrency`.

- Source SHA-256: TypeScript `d5c2a283720bf7e65cc884c41afe533d4fb7ee6b4f3ad898f1078798d340144d`, Rust `a3c84cd16b59ce5b0d385428bb7bf8af0560873e86b6158f9699662e15d33061`.
- Fixture SHA-256, identical for both implementations: `pcm_ingest` `63faf10d…82c0`, `cosine_ranking` `cde45701…c941`, `archive_streaming` `d2203657…ae10`, `transcript_ingest` `9875572f…d893`, `context_read_write` `5feceb66…57e9` (full values in each record).
- MySQL end-state fingerprint, identical for both: SHA-256 `8b07c217fbbe4d06d9c26eeddb1200b9d33ca45bd0ceb8f4140e838d2db5f282`.
- Host: shared 8-core virtual machine (Intel Haswell class, no TSX, 23 GiB RAM) running other agents' builds and tests, load average 4.4 at the start and 2.4 at the end; MySQL 8.4 server shared with other test runs.
- Runtimes: Node.js 24.19.0 (V8 13.6.233.17); rustc 1.97.1 release build (opt-level 3, thin LTO, one codegen unit).

| Workload | Phase | TS ops/s | Rust ops/s | TS p50 / p95 / p99 ms | Rust p50 / p95 / p99 ms | CPU % TS / Rust | Peak RSS MiB TS / Rust |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `pcm_ingest` (50,000 frames) | steady | 551,992 | 3,706,470 | 0.001 / 0.004 / 0.008 | 0.000 / 0.000 / 0.000 | 178 / 90 | 320 / 4 |
| `cosine_ranking` (10,000 x 1,024) | cold | 9.1 | 68.8 | 110.0 / 110.0 / 110.0 | 14.4 / 14.4 / 14.4 | 143 / 100 | 350 / 44 |
| `cosine_ranking` (10,000 x 1,024) | steady | 14.9 | 67.7 | 63.5 / 85.8 / 140.0 | 14.5 / 16.5 / 17.7 | 98 / 99 | 351 / 44 |
| `archive_streaming` (24 x 30 s) | steady | 25.8 | 39.6 | 36.2 / 54.0 / 112.3 | 23.5 / 32.2 / 37.6 | 65 / 75 | 319 / 11 |
| `transcript_ingest` (2,000) | steady | 63.2 | 82.4 | 15.3 / 21.7 / 27.6 | 12.2 / 16.6 / 19.7 | 48 / 11 | 439 / 10 |
| `context_read_write` (5,000) | steady | 244.2 | 408.9 | 2.6 / 11.7 / 16.1 | 1.5 / 7.1 / 9.0 | 66 / 20 | 487 / 113 |

Saturation (`pcm_ingest`, open loop, one stream):

| Offered frames/s | TS p99 ms | Rust p99 ms | TS achieved | Rust achieved |
| --- | --- | --- | --- | --- |
| 3,200 | 1.4 | 0.833 | 3,201 | 3,201 |
| 102,400 | 4.6 | 0.399 | 102,430 | 102,429 |
| 819,200 | 31.8 | 0.666 | 819,369 | 819,484 |
| 1,638,400 | 1,443.4 | 0.065 | 948,210 (saturated) | 1,639,118 |
| 3,276,800 | not run | 2.7 | - | 3,273,965 |
| 6,553,600 | not run | 1,187.7 | - | 4,097,801 (saturated) |

TypeScript sustained 819,200 offered frames/s and saturated at 1,638,400; Rust sustained 3,276,800 and saturated at 6,553,600.
At low offered rates the p99 mostly reflects the driver's timer wake-ups on a loaded host rather than frame work.

Long run (`pcm_ingest`, 300 s at 3,200 frames/s): TypeScript RSS grew 5.3 MiB after warm-up (peak 320 MiB); Rust grew 6.6 MiB, which the 7.3 MiB per-frame latency buffer of the harness accounts for.
Both stayed within the declared 16 MiB bound, and both p99 latencies stayed under 1 ms.

## Status and controlled-host run

The matched harness, the Rust reference and the results above exist; TypeScript/Rust parity is neither claimed nor refuted.
The manifest's `reference_hardware`, `runtime` and `limits` fields stay `null` and `unverified` (T01), so every parity gate and absolute budget stays unrun.
A controlled-host run must:

1. Name the machine in `workload.json`: CPU model, cores, RAM, OS, Node.js/V8 and rustc versions, release flags, CPU and memory limits; set `status: "verified"` only after checking each value on that machine.
2. Run nothing else on it; pin both implementations to the same declared cores and memory limit, fix the CPU frequency, and give MySQL 8.4 its own cores and a fixed buffer pool with no other databases.
3. Run `node scripts/benchmark-compare.ts --mysql-url ... --out ...` at least five times from a cold start and report the median and spread of every record.
4. Compare each workload's TypeScript/Rust throughput and p95/p99 ratios at matched offered load with its manifest `parity_gate`; the runner prints the ratios but evaluates no gate.
5. Add concurrent drivers to both implementations before sweeping the manifest's `concurrency` and `concurrent_uploads` lists; both harnesses run one operation at a time today.
6. Keep the 24-hour soak (T26) separate: this long run bounds memory for 300 s of one workload only.

Also unrun: MySQL workload saturation (sweeping load on the shared test server would disturb other runs), slow consumers and reconnect storms (they need the socket layer, which the workloads exclude), and live-provider latency.
