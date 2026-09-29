# Sanctum implementation instructions

## First action

Read HANDOFF.md, tasks/plan.md, tasks/todo.md, docs/DESIGN.md, and docs/DECISIONS.md before implementation.
This is a handoff-only repository; build fresh application code here.
Do not clone, copy, vendor, or import source code from the old Sanctum repository.
Reference links are historical evidence and product context, not implementation dependencies.

## Product invariants

- TypeScript + stable Effect v3 on Node.js; npm lockfile; one application image for API and worker entrypoints.
- Python belongs only to the promised client SDK; capture, server, workers and MCP use TypeScript.
- Performance: follow plan section 04; keep hot audio loops plain TypeScript and publish matched benchmark evidence before claiming Rust parity.
- Website first: browser microphone permission, no installed application requirement.
- The capture tab must stay open; do not claim recording after browser closure or OS sleep.
- Fullscreen listening view with the approved irregular waveform; no permanent dashboard/sidebar.
- Silent unless directly requested; background task completion must not speak.
- Keep full transcripts and R2 audio independently of selective memory.
- MySQL is the structured store; no Postgres/pgvector runtime dependency.
- Context is versioned, time-aware, source-linked, and scoped to authorized teams/meetings.
- SDK, MCP, UI, and workers use the same authorization and domain behavior.
- Pipedream catalog stays server-side; only search, selected-action inspection, and action-request gateways enter prompts.
- External actions require stored permission and truthful receipts; ambiguous completion is not safe to retry blindly.

## Execution

Run `npm run docs:render` after editing handoff sources, then `npm run check` and `npm run docs:build`.
The checked template is `scripts/handoff-template.html`; generated HTML/brief/snippets must not be hand-edited.
Follow the ordered checklist and finish its local checks before reporting a slice complete.
Slice ownership, seams and hot files: docs/ARCHITECTURE.md; application checks: `npm run check:app`.
Running, migrating and recovering: docs/operations.md; acceptance evidence and unrun gates: docs/release-evidence.md.
Use current official provider documentation and pin compatible dependencies.
Implement concrete modules and reuse platform features; avoid speculative frameworks.
Use synthetic fixtures and stub external writes in tests.
Do not copy private recordings, contacts, seed data, tokens, or environment files from the reference system.
The repository CI validates the handoff and deploys documentation.
Extend it with real application checks as corresponding implementation is added; avoid placeholder tests.
Use read-only permissions for pull-request checks and keep production secrets out of documentation CI.
Fallow, Sentrux and Conventional Commit gates are required in CI.
Stage new source files, run npm run quality:fallow -- --base HEAD and npm run quality:sentrux, and preserve the committed baseline.
Keep commit headers and PR titles in Conventional Commit format with a 72-character header limit.
Do not weaken thresholds, exclusions or baselines to make a failing gate pass.
Do not add AI/agent co-author attribution to commits.

## Decisions and release boundaries

Confirmed choices are recorded in docs/DECISIONS.md; do not repeatedly ask them.
Unresolved sign-in and recording policies remain explicit; finish independent code without silently inventing a policy.
Repository creation is not permission to provision paid services, send messages, create real events, run production migrations, publish packages, deploy, or activate live recording.
Ask at those boundaries when the user has not already authorized the specific action.
Report implementation, local tests, model evaluation, deployment, and live verification separately.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
