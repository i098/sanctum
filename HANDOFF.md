# Build Sanctum from this handoff

Implement a new application in `undeemed/sanctum` using tasks/plan.md and tasks/todo.md.
This repository intentionally contains no old application code.
Do not fetch or copy the old source as a shortcut.
Recreate the approved appearance independently using docs/DESIGN.md and design/listener-reference.html.

Deliver a website-first ambient listener for room computers and laptops.
It remains silent until requested, automatically separates meetings, saves complete transcripts and private R2 recordings, builds time-aware selective memory, performs research and previously authorized Pipedream actions, and exposes shared context through TypeScript/Python SDKs and authenticated remote MCP.
Agents do most reading and writing; the human interface stays fullscreen and minimal.

Use TypeScript on Node.js 24 LTS with stable Effect v3, React/Vite, MySQL, R2 and Pipedream.
One Node application image serves API, MCP and authenticated WebSocket audio; a second entrypoint runs durable MySQL-backed jobs.
Keep browser capture, playback cancellation and archive recovery explicit; Effect is orchestration, not a speech engine.
Optimize TypeScript for the named workloads in plan section 04: typed binary buffers, bounded queues, minimal copying and Effect outside per-sample loops.
Require reproducible latency/throughput/CPU/memory comparisons before claiming Rust-level performance; never weaken correctness to improve a score.
Keep the promised Python SDK as a thin client only.
Use npm and the checked lockfile; the application runtime has no Python service dependency.
Keep only three integration gateways in model context: search, inspect one selected action, and request execution.
Implement actual behavior and tests, not only the illustrative interface.

Read docs/DECISIONS.md before dependent work.
Website capture, TypeScript + Effect, MySQL, R2, silent behavior, automatic meeting boundaries, and the visual direction are settled.
The human sign-in/MCP authorization-server configuration and recording policies have not yet been selected.
Do not silently invent these policies; complete independent implementation and fixtures while they remain open.
No prior data import or legacy API compatibility is required unless separately requested.

Work through the checklist in vertical slices with internal verification checkpoints.
Resolve ordinary code decisions autonomously within this contract.
Preserve source timing, tenant isolation, evidence provenance, revisions, and idempotent receipts.
Never send real integration writes during test replay.

The old source was reviewed at `42nights/sanctum@49aef4a49fa5facc485d5858690860fd028491d7`; this is provenance only.
Provider research was collected in September 2026 and must be verified against current official docs before dependency/model selection.
Do not claim unrun model benchmarks, real delivery, or production uptime from local mocks.

Run `npm ci` and `npm run check` before changing planning files.
After edits, run `npm run docs:render`, `npm run check` and `npm run docs:build`; commit generated output.
The authorized documentation CI/CD remains active; add actual application checks when application code exists.
Replace planning examples with complete, runnable SDK examples when implementation exists.
Finish with explicit implemented/tested/web-built/deployed/live-verified states and supporting evidence.
Production recording, migrations, paid provisioning, outbound actions, package publication, and deployment need their own authorization.
