# Clean-build execution checklist

Run these slices in order unless an independent check can run alongside the current slice.
The full behavioral contract is `tasks/plan.md`; the approved visual reference is `docs/DESIGN.md` and `design/listener-reference.html`.
Paths below are repository-relative proposed edit targets.
Every task must end with its verification result, not only code changes.
These checks are a proposed suite to implement, not tests already present in the baseline.

## T01. Establish the new project and checks

- [ ] Create the React/Vite and Python service structure described in the plan; do not copy the old repository.
- [ ] Add dependency manifests, local development commands, and synthetic fixtures.
- [ ] Add a local check entrypoint with external side effects disabled in tests.

Files: root manifests, `web-app/package.json`, Python configuration, `scripts/check.py`, `tests/test_baseline.py`.
Verify: empty project builds; local test command runs; fixtures never call live integrations.
Depends on: none.

## T02. Create MySQL schemas and connection handling

- [ ] Add versioned InnoDB schemas and a migration ledger for the new domain.
- [ ] Implement Connector/Python pooling, UTC handling, explicit transactions, and dictionary rows.
- [ ] Make schema setup restart-safe without assuming rollback of multi-statement DDL.

Files: `backend/migrations/001_initial.sql`, `backend/migrate.py`, `backend/db.py`, `tests/test_migrations.py`.
Verify: fresh database, repeated setup, interrupted DDL, constraints, UTC/JSON/Unicode round trips.
Depends on: T01.

## T03. Implement scoped persistence operations

- [ ] Add repositories for workspace/principal/meeting ownership using parameterized MySQL queries.
- [ ] Define uniqueness, upsert, pagination, and revision semantics explicitly.
- [ ] Test case-sensitive identifiers and isolation from the first query layer.

Files: `backend/store.py`, `backend/models.py`, `tests/test_store.py`.
Verify: two workspaces, duplicate keys, empty results, revision conflicts, and correct transaction rollback for DML.
Depends on: T02.

## T04. Implement semantic matching

- [ ] Generate/store versioned profile embeddings in MySQL with model/dimension metadata.
- [ ] Implement scoped batched exact cosine ranking and appropriate result verification.
- [ ] Benchmark O(N × dimensions) latency and memory against a stated directory-size target.

Files: `backend/matcher.py`, matching schema migration, runtime requirements, `tests/test_semantic_matching.py`, `scripts/benchmark_matching.py`.
Verify: labeled ranking fixtures, invalid vectors, model/dimension mismatch, tenant isolation, and scale measurements.
Depends on: T03.

## T05. Enforce a shared authorization boundary

- [ ] Implement verified human identity and workspace membership; distinguish login from Pipedream action linking.
- [ ] Add credential principal/scope resolution and consistent resource access checks.
- [ ] Apply the same authorization functions to all API routes and worker jobs.

Files: `backend/auth.py`, `backend/app.py`, `backend/agents.py`, `backend/cache.py`, `tests/test_authorization.py`.
Verify: two workspaces, colliding names, expired/revoked credentials, missing session membership, and denied cross-workspace access.
Depends on: T04; production issuer configuration remains a live gate.

## Checkpoint A. Identity and migration safety

- [ ] MySQL schema and transactions preserve explicit ownership and semantic matching records.
- [ ] Every API surface enforces ownership.
- [ ] No cached response can cross principal/workspace scope.

## T06. Establish browser microphone capture

- [ ] Implement the React website and browser microphone permission flow on room computers and laptops.
- [ ] Keep the capture controller independent of overlay mounts; closing a tab stops capture and produces an interrupted state.
- [ ] Handle secure-context, permission pending/denied, missing/dead input, and optional Wake Lock behavior.

Files: `web-app/src/lib/capture/controller.ts`, `web-app/src/pages/listen/engine.ts`, `web-app/src/lib/capture/permissions.ts`, `web-app/tests/capture-lifecycle.test.ts`.
Verify: permission grant/denial/revocation, input unplug, overlay close, tab reload, sleep/discard recovery; no native install required.
Depends on: T01, T05.

## T07. Buffer independent audio chunks in the browser

- [ ] Tap the selected microphone, preserve source/sample clocks, and produce independent valid WAV chunks.
- [ ] Commit bounded recovery records to IndexedDB and monitor quota; persistent storage is requested only where supported.
- [ ] Distinguish buffered data from R2-confirmed data and expose eviction/quota failures honestly.

Files: `web-app/src/lib/capture/recorder.ts`, `web-app/src/lib/capture/recording-worklet.ts`, `web-app/src/lib/capture/buffer.ts`, `web-app/tests/capture-buffer.test.ts`.
Verify: sample-count fixture, reload recovery, storage denied/cleared/full, no cleanup of unacknowledged chunks.
Depends on: T06.

## T08. Register listeners and recoverable source manifests

- [ ] Add listeners, capture epochs, ownership generations, and recording manifests.
- [ ] Authenticate device registration, heartbeats, and authorized WebRTC offer bindings.
- [ ] Return source watermarks so reconnect resumes instead of restarting the meeting.

Files: `backend/migrations/002_capture.sql`, `backend/listeners.py`, `backend/app.py`, `tests/test_listeners.py`.
Verify: unauthorized signaling rejection; stale ownership generation; reconnect with identical epoch; two independent rooms.
Depends on: T05.

## T09. Upload audio to R2 with durable receipts

- [ ] Add chunk ingest validation and server-side R2 writes, manifest commit, and reconciliation.
- [ ] Implement browser retry/receipt journaling and local cleanup only after acknowledgement.
- [ ] Keep object credentials server-side and distinguish locally saved from remotely saved data.

Files: `backend/recordings.py`, `web-app/src/lib/capture/uploader.ts`, `tests/test_recording_uploads.py`, `web-app/tests/uploader.test.ts`.
Verify: R2 success/DB failure; repeated identical chunk; conflicting hash; timeout; offline backlog recovery.
Depends on: T07, T08; real R2 credentials only for a separate authorized live check.

## T10. Implement scoped WebRTC and reconnect

- [ ] Implement Pipecat/WebRTC and bind authenticated listener/epoch/source-clock metadata during signaling.
- [ ] Persist structured final transcription segments; keep partials provisional.
- [ ] Reconnect through source watermarks without equating peer IDs with meeting IDs.

Files: `realtime/ingest.py`, `realtime/server.py`, `backend/transcripts.py`, `backend/migrations/003_transcripts.sql`, `tests/test_ingest.py`.
Verify: repeated/out-of-order final segments, reconnect, recording/ASR alignment, provider outage, unauthorized offer denial.
Depends on: T08.

## T11. Reconcile offline transcript coverage

- [ ] Schedule batch transcription for uploaded source ranges missing final ASR coverage.
- [ ] Deduplicate live and replayed source spans by epoch/track/range and retain correction history.
- [ ] Preserve gap markers and never replay historical audio into room speakers or action execution.

Files: `backend/transcripts.py`, `backend/jobs.py`, `backend/worker.py`, `backend/migrations/004_jobs.sql`, `tests/test_transcript_recovery.py`.
Verify: upload before/after live final; provider retry; duplicate batch delivery; process crash during reconciliation.
Depends on: T09, T10.

## Checkpoint B. Real capture vertical slice

- [ ] Browser capture buffers pending data, uploads, and produces retrievable transcript/source records.
- [ ] Closing a review overlay does not stop capture; closing the tab is detected as an interruption.
- [ ] Simulated offline/crash replay preserves remotely acknowledged evidence and accurately reports unavailable browser-buffered data.

## T12. Implement automatic meeting lifecycle

- [ ] Create provisional/active/closing/closed/interrupted meetings independently of listener lifetime.
- [ ] Evaluate boundaries from evidence and context; keep uncertain boundaries revisable.
- [ ] Close capture ranges immediately and schedule final work separately from action draining.

Files: `backend/meetings.py`, `backend/boundaries.py`, `backend/migrations/005_meeting_ranges.sql`, `realtime/server.py`, `tests/test_meeting_boundaries.py`.
Verify: pause versus true boundary, explicit close, back-to-back conversations, new speech during old meeting processing.
Depends on: T11.

## T13. Add boundary correction and safe recording playback

- [ ] Implement revision-checked split/merge transactions and recompute derived source ownership.
- [ ] Assemble or stream an authorized per-meeting audio cut; never grant a URL to another meeting's audio.
- [ ] Preserve prior action IDs/receipts when meeting boundaries move.

Files: `backend/meetings.py`, `backend/recordings.py`, `tests/test_boundary_corrections.py`, `tests/test_playback_access.py`.
Verify: sample coverage, incompatible access scopes, stale revisions, old/new playback cuts, no repeated side effects.
Depends on: T12.

## T14. Make speaker attribution structured and correctable

- [ ] Persist provider-local speaker tracks, timestamps, and attribution revisions.
- [ ] Implement optional pyannote live and batch adapters behind explicit configuration.
- [ ] Support unknown labels, explicit person mapping/enrollment, and provider stream rotation.

Files: `realtime/speakers.py`, `backend/speakers.py`, `backend/migrations/006_speakers.sql`, `tests/test_speakers.py`, `scripts/evaluate_speakers.py`.
Verify: overlap, reconnect/rotation, similar voices, unknown participants, map correction, no voice-based authorization.
Depends on: T10, T13.

## T15. Centralize model roles and extract canonical notes

- [ ] Add explicit role settings and validated structured extraction with correctly handled hosted research tools.
- [ ] Generate one canonical summary for notes, email discussion sections, and exports.
- [ ] Remove silent live fallback to demo content and keep failures recoverable from source data.

Files: `shared/config.py`, `backend/llm.py`, `backend/context.py`, `backend/planner.py`, `tests/test_extraction.py`.
Verify: schema/grounding/date fixtures; candidate output comparison against labeled fixtures; unavailable provider without fake success.
Depends on: T12.

## T16. Build versioned time-aware shared context

- [ ] Add attributed context items, source refs, temporal fields, and immutable revisions.
- [ ] Add committed-order change events, access-bound cursors, and optimistic concurrency.
- [ ] Build bounded authorized retrieval and Jcyber-inspired memory distillation; coalesce active context jobs.

Files: `backend/migrations/007_context.sql`, `backend/context.py`, `backend/cache.py`, `tests/test_context.py`, `tests/test_context_changes.py`.
Verify: two-agent conflict, midnight/DST/delayed upload, source access, revoked cursor, missing source, distillation retry.
Depends on: T05, T11, T15.

## Checkpoint C. Meeting context is trustworthy

- [ ] Transcript, audio, attribution, boundaries, and context revisions align.
- [ ] Memory selection does not alter raw evidence.
- [ ] Actor/source/time scope survives corrections and retries.

## T17. Implement Pipedream discovery and execution access

- [ ] Implement one Connect client for discovery, account scope, and Google/Drive operations.
- [ ] Expose only search, inspect, and request-action gateways: at most five metadata search hits, one selected action schema/configuration, and bounded paginated options.
- [ ] Bind connected accounts to stable principals and explicit meeting/workspace permissions.

Files: `shared/pipedream_client.py`, `backend/agents.py`, `backend/integrations.py`, `tests/test_pipedream.py`.
Verify: a 10,000-action fixture does not expand the eleven-tool MCP surface; check account isolation, Drive bytes, missing connections, provider failure, dynamic schema, stale configuration, paginated options, and output budgets.
Depends on: T05.

## T18. Persist grants, actions, and receipts

- [ ] Add stored action grants and a shared execution gateway for internal/external agents.
- [ ] Use stable idempotency keys, job leases, revocation checks, and provider receipt reconciliation.
- [ ] Represent ambiguous completion as unknown and block unsafe automatic replay.

Files: `backend/migrations/008_actions.sql`, `backend/action_service.py`, `backend/executor.py`, `tests/test_actions.py`.
Verify: mismatched/expired/revoked grants; duplicated requests; timeout after upstream success; no real sends in tests.
Depends on: T11, T16, T17.

## T19. Make background work independent of media connections

- [ ] Run context, memory, notes, research, and external actions through durable jobs with explicit work keys.
- [ ] Keep capture nonblocking and recover worker leases after restart.
- [ ] Implement bounded rate/budget states that can resume instead of silently stopping work after a fixed cycle count.

Files: `backend/worker.py`, `backend/jobs.py`, `tests/test_worker_recovery.py`.
Verify: kill media and worker independently; late completion; concurrent claim; stale lease; budget pause and resume.
Depends on: T16, T18.

## T20. Enforce silence across all output paths

- [ ] Add a request-scoped speech gate immediately before audio emission.
- [ ] Cover direct responses, tool responses, meeting close, and action completion so only requested speech is emitted.
- [ ] Keep passive frontend transitions silent while supporting explicit user playback.

Files: `realtime/speech_gate.py`, `realtime/server.py`, `backend/worker.py`, `web-app/src/pages/listen/engine.ts`, `tests/test_silence.py`.
Verify: zero unsolicited speech/SFX across ordinary capture and all background transitions; requested reply positive control.
Depends on: T10, T19.

## T21. Deliver fullscreen listening and review overlays

- [ ] Recreate the approved waveform independently; connect it to real capture state and analyser levels.
- [ ] Add Notes/Transcript/Recording/Memory/Context/Activity overlays with source navigation.
- [ ] Keep capture independent of overlay visibility; implement focus, keyboard, reduced-motion, and error behavior.

Files: `web-app/src/pages/listen/engine.ts`, `web-app/src/pages/listen/waveform.ts`, `web-app/src/pages/listen/index.tsx`, `web-app/src/pages/listen/listen.css`, `web-app/src/pages/listen/ReviewDialog.tsx`.
Verify: accepted-preview visual comparison, 1280×720 and narrow layout, overlay open/close, source seek, capture interruption truthfulness.
Depends on: T06, T13, T16, T20.

## T22. Add scoped REST contracts and generated SDKs

- [ ] Publish explicit v1 OpenAPI models, operation IDs, pagination, error shapes, idempotency, and conflicts.
- [ ] Implement TypeScript/Python clients and runnable examples using generated DTOs.
- [ ] Verify UI and both SDKs call the same domain behavior.

Files: `backend/api_v1.py`, `scripts/generate_sdks.py`, `sdk/typescript/`, `sdk/python/`, `tests/test_api_contract.py`.
Verify: contract snapshot, pagination, cancellation, safe retries, context read/write/conflict, changes replay, action receipt retrieval.
Depends on: T16, T18.
Subdivide package scaffolding into smaller edits if a single edit wave exceeds the five-file guideline.

## T23. Add authenticated MCP and agent management

- [ ] Mount explicit tools over shared services; include source/context resources where useful.
- [ ] Wire delegated OAuth with durable credential storage, audience checks, and scope mapping.
- [ ] Add agent permission/revoke UI and test real MCP clients with different principals.

Files: `backend/mcp_server.py`, `backend/auth.py`, `web-app/src/pages/listen/AgentsDialog.tsx`, `tests/test_mcp.py`, `sdk/examples/`.
Verify: auth/discovery/schema/read/write/conflict/revoke; client-version compatibility; no admin/capture routes auto-exposed.
Depends on: T05, T21, T22.

## Checkpoint D. Human and agent interfaces agree

- [ ] Fullscreen listener works without a permanent dashboard.
- [ ] Both SDKs and MCP see the same authorized context revisions and receipts.
- [ ] Revocation and stale writes are verified, not only documented.

## T24. Build and serve the complete website

- [ ] Serve the website over HTTPS with microphone permissions policy, secure session cookies, and appropriate CSP.
- [ ] Build frontend assets into the API image; package shared modules in API/media images.
- [ ] Add worker command, persistent storage, reverse-proxy routes, and configurable local ports.

Files: `web-app/vite.config.ts`, `backend/Dockerfile`, `realtime/Dockerfile`, `docker-compose.yml`, `Caddyfile`.
Verify: fresh browser visit, HTTPS microphone permission, WebRTC routing, API/MCP routing, worker restart, page reconnect, and secret-free web assets.
Depends on: T19, T21, T23.

## T25. Complete multi-listener handoff and capability coverage

- [ ] Verify capture-group membership, room preference, ownership lease, and laptop takeover.
- [ ] Verify notes, matching, exports, meeting links, and scoped account mapping.
- [ ] Rehearse safe release rollback with recorded sources and action receipts preserved.

Files: `backend/listeners.py`, `web-app/src/lib/capture/controller.ts`, `backend/api_v1.py`, `tests/test_handoff.py`, `tests/test_capabilities.py`.
Verify: simultaneous room/laptop, network partition, stale owner, different private meeting, account isolation and meeting deep links.
Depends on: T24.

## T26. Validate, soak, and hand off

- [ ] Run all local behavior, contract, SDK and browser, migration, and failure-recovery checks.
- [ ] Run approved model/audio comparison and stage a 24-hour soak before claiming live 24/7 verification.
- [ ] Report implemented/tested/web-built/migrated/deployed/live-verified separately with evidence and remaining blockers.

Files: `scripts/check.py`, `scripts/replay_capture.py`, `tests/fixtures/day.json`, `docs/operations.md`, `docs/release-evidence.md`.
Verify: every acceptance row in the plan has a pass, failure, or explicit unrun reason; no unexplained skipped work.
Depends on: T25.

## Final boundaries

- [ ] Source changes reviewed; Sentrux gate run if the execution checkout has a baseline.
- [ ] CI configuration remains unchanged unless the user requested it.
- [ ] Production migrations, deployment, package publication, and recording activation occur only within explicit authorization.
- [ ] Existing handoff material and any future stored recordings/sessions are preserved.
- [ ] No false claim of real-world model quality, delivered side effects, or 24-hour uptime from mocked tests.
