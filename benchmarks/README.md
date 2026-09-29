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

## Harness

`node scripts/benchmark.ts [--smoke] [--mysql-url mysql://...] [--out file.jsonl]` (`npm run benchmark`) runs the TypeScript side of every workload through the real application code:

| Workload | Timed operation | Scope note |
| --- | --- | --- |
| `pcm_ingest` | `decodePcmFrame` plus dispatch into a bounded 256-frame queue | Frame validation and dispatch only; socket, auth and ASR excluded. |
| `archive_streaming` | `putChunk`: WAV shape, SHA-256, manifest claim, object write, commit | In-memory object store with the production interface; real MySQL. |
| `transcript_ingest` | `publishFinalWindow`: segments, coverage and meeting hooks | Real MySQL. |
| `context_read_write` | `getContextSnapshot` and `addContextItem`, 9 reads per write | Real MySQL; cites segments created by `transcript_ingest`. |
| `cosine_ranking` | Exact float32 top-k (`scripts/benchmark-matching.ts`) | In-process, verified against a full-sort reference. |

The MySQL workloads create and drop a `sanctum_bench_*` database; without a URL they are reported as unrun.
Operations run sequentially (concurrency 1); the manifest's concurrency and saturation sweeps are not yet driven.
`npm run check:app` runs `--smoke` as a correctness check: a failed operation or invalid record fails the step, timings never do.

## Results

[results/typescript-52866cd-local.jsonl](results/typescript-52866cd-local.jsonl) holds one full-scale TypeScript run at commit `52866cd` (SHA-256 `a3c9a570f5cc641f09d23aeebaf6108c23f6efeccf3be91df461352ba54111e1`), with zero failed operations and each record's fixture SHA-256.

| Workload | Phase | Operations | Throughput (ops/s) | p50 ms | p99 ms | Peak RSS MiB |
| --- | --- | --- | --- | --- | --- | --- |
| `pcm_ingest` | steady | 50,000 frames | 305,692 | 0.001 | 0.007 | 317 |
| `cosine_ranking` (10,000 x 1,024) | cold | 1 | 3.0 | 332.3 | 332.3 | 350 |
| `cosine_ranking` (10,000 x 1,024) | steady | 199 | 7.8 | 104.9 | 314.1 | 350 |
| `archive_streaming` (30 s chunks) | steady | 24 | 8.8 | 81.8 | 608.3 | 358 |
| `transcript_ingest` | steady | 2,000 | 25.2 | 33.4 | 129.2 | 416 |
| `context_read_write` | steady | 5,000 | 67.5 | 7.6 | 100.2 | 416 |

The run used a shared 8-core virtual machine (Intel Haswell class, 22 GiB RAM, Node.js 24.19.0) under a load average of about 32, against a MySQL 8.4 server shared with other test runs.
These numbers are illustrative only: they are not reference-hardware measurements and support no capacity, budget or parity claim.

## Status

No controlled benchmark host is configured, so hardware, runtime and limit fields are `null` and marked `unverified`.
That missing configuration is an explicit unrun gate, not a pass.
No Rust reference implementation exists, so every parity gate is unrun and TypeScript/Rust parity is unverified.
Saturation sweeps, concurrent offered load, reconnect storms and long-run memory bounds are also unrun; the accelerated day replay (`npm run replay:capture`) only bounds memory over one synthetic day of source time.
