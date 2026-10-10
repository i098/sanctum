# Sanctum: clean-build implementation contract

Prepared 2026-09-26; clean-build contract revised for TypeScript + Effect on 2026-09-28.
Reference system: `42nights/sanctum` at `49aef4a49fa5facc485d5858690860fd028491d7`.
Target repository: `undeemed/sanctum`.
Build from an empty application tree; do not clone, copy, vendor, or import the old application source.
Old file paths below are historical evidence only, never instructions to copy files.
The binding visual contract is `docs/DESIGN.md` with the independently authored references in `design/`.
This is an implementation handoff, not implemented or deployed software.
The approved visual direction is described in `docs/DESIGN.md` and illustrated by independently authored design references.

## 01. Deliverable and fixed decisions

Deliver one integrated clean build: a silent ambient listener, isolated automatic meetings, complete recording/transcript evidence, selective time-aware context, authorized background work, and shared agent access.
Build a website first, using browser microphone access on room computers and laptops.
Both use the same account, meeting identifiers, API, context model, and authenticated WebSocket capture path.
Opening or closing a review overlay must not stop capture; closing the browser tab stops microphone capture.
No installed application, Electron shell, browser extension, or native capture component is in this version.
A sleeping or powered-off device cannot record; display and store a capture gap rather than claiming otherwise.

Preserve the existing fluctuating blue-white waveform, with roughly 33 irregular needle regions, asymmetric underside, ink bleed, and soft glow.
Keep the primary screen fullscreen with sparse edge controls; meetings and agent settings are secondary overlays.
Agents do most context reading and writing through SDK/MCP.
Retain research, requested speech, matching, Pipedream integrations, notes, export, and post-meeting work.
Residency and batch concepts are not part of the primary information model.

Confirmed behavior:

- Capture is silent until a direct request opens a spoken-response window.
- Research and previously authorized actions may run without speaking.
- Detect meeting boundaries automatically; allow manual split and merge.
- Keep complete meeting transcripts and audio recordings in private R2 storage.
- Memory selection never deletes the source transcript or recording.
- Date, time, timezone, speaker attribution, provenance, and access scope are part of context.
- People and external agents share one authoritative context store.

The implementation must include actual backend behavior, working browser capture, a working UI, SDKs, MCP, migrations, and meaningful tests.
A mock dashboard or an API-shaped stub does not satisfy this contract.

## 02. Decisions and activation requirements

### Confirmed

- Capture surface: website microphone access on both room computers and laptops; keep the listener tab open.
- Default UI: fullscreen listening, preserving the current waveform.
- Runtime: TypeScript on Node.js 24 LTS with stable Effect v3; one application image with API and worker entrypoints.
- Media: browser AudioWorklet to authenticated WebSocket ingest; cloud speech APIs, with no separate media service.
- Storage: MySQL 8.4 LTS with InnoDB for structured data; Cloudflare R2 for audio.
- MySQL is the only runtime structured store. Legacy data import is outside this first clean build unless separately requested.
- Integrations: Pipedream with catalog discovery and the specified Google operations.
- Interaction: silent background operation; speak only in a requested interaction.

### Still to choose

- MCP authorization server and identity issuer: decided on 2026-10-08 in docs/DECISIONS.md (WorkOS AuthKit hosted, embedded Better Auth self-hosted, both standard OIDC and OAuth selected by configuration).
- Saved meeting retention: how long confirmed recordings and transcripts are kept before automatic deletion; no automatic expiry has been authorized.
- Unassigned audio buffer: how long to hold captured speech before it has been assigned to a meeting, if the policy archives detected meetings only. This is separate from the offline upload recovery queue.
- Speech outside a detected meeting: requires an explicit archive policy before unattended production capture is enabled.

Do not invent these answers while implementing.
Complete independent work and keep dependent integration clearly marked until the answer exists.
For local tests, use fixture identities, a disposable database, synthetic audio, and a local object-store fake.
For production activation, require explicit workspace timezone, selected microphone, storage credentials, outside-meeting policy, and a working identity issuer.
Do not automatically create paid services, publish packages, run production migrations, or activate recording merely by executing this brief.

### Recommended engineering defaults — proposals, not measured optima

- Archive independent 30-second PCM16 WAV chunks from the microphone using the actual capture sample rate; resample only through a verified conversion.
- Commit browser recovery data to IndexedDB about every 2 seconds; distinguish browser-buffered data from R2-confirmed data.
- Bound the browser recovery buffer by available quota and an application cap; on exhaustion, visibly pause capture rather than silently discard unuploaded data.
- Device heartbeat every 15 seconds; ownership lease expires after 45 seconds.
- One coalesced context job per active meeting, after 25 seconds with new speech or four new turns.
- A five-minute speech gap can trigger boundary evaluation; it does not itself establish that a meeting ended.
- Signed playback URLs expire after five minutes; new URLs require a fresh access check.
- Completed recordings/transcripts have no automatic expiration until a retention policy is selected.

These values are acceptance-test inputs and calibration starting points.
Keep them in a small configuration object, not scattered literals or a large user-facing settings system.

## 03. Clean-build boundary

This repository intentionally contains no legacy application code.
The earlier system informed the product requirements, but its architecture is not a foundation to reproduce.
Use the selected stack and recreate the approved visual behavior independently.

Keep the useful behaviors: silent capture, requested speech, complete sources, selective memory, research, matching, and permitted integration actions.
Replace demo-specific concepts with scoped team meetings.
Avoid the old failure modes: global room state, connection-owned background jobs, repeated full transcripts in prompts, capture saved only at session end, and automatic spoken status updates.

Do not add a Postgres driver, pgvector, old residency data, old prompts/persona files, old credentials, or old API compatibility routes.
Use synthetic fixtures rather than copying private seed recordings, contacts, or transcripts.
Importing historical data is a separate optional migration project, not an initial acceptance gate.

## 04. Chosen technology stack and runtime

### Technology selection

Use this stack for the website-first implementation.
Implement the chosen technologies from scratch; add a library only for a requested capability.
Pin exact compatible versions during implementation rather than copying unverified version numbers into a new lockfile.

| Layer | Chosen technology | Purpose and status |
| --- | --- | --- |
| Website | React + TypeScript + Vite + Tailwind CSS | Preserve the approved fullscreen listening contract. |
| Waveform and capture | Canvas 2D + Web Audio + AudioWorklet + `getUserMedia` | One microphone stream, real levels, sample-clocked audio; HTTPS permission required. |
| Live media | Binary PCM over authenticated WebSocket to Node.js | One live ingest path, explicit source anchors, bounded queues, reconnect and speech cancellation. |
| Recording buffer | Independent PCM16 WAV chunks + IndexedDB | Browser recovery journal; only an R2 receipt means remote durability. |
| API and runtime | Node.js 24 LTS + TypeScript + `effect` v3 + `@effect/platform` + `@effect/platform-node` | Effect HttpApi, Schema, typed failures, resource scopes, bounded concurrency and cancellation. |
| Database | MySQL 8.4 LTS + InnoDB + `@effect/sql-mysql2` | Parameterized SQL, pooled connections, transactions, ownership constraints and durable leases. |
| Retrieval | MySQL FULLTEXT + exact batched cosine ranking in TypeScript | Normalized float32 embeddings, scoped candidate batches, measured event-loop and memory budgets. |
| Recording archive | Cloudflare R2 S3 API through `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` | Private audio, manifests and scoped short-lived playback URLs. |
| Background work | Node.js worker using Effect + MySQL job/lease table | Restart-safe accepted work, coalescing and fenced completion; no additional queue service. |
| Fast LLM | Cloudflare Workers AI `@cf/qwen/qwen3.8-27b`, through its OpenAI-compatible chat completions endpoint | Requested speech and structured notes/memory on the account Sanctum already runs on; smoke-compared on synthetic fixtures (see `docs/release-evidence.md`), not a measured winner. |
| Planner | See the planner provider decision in `docs/DECISIONS.md`. | Spoken-work decisions and inspected action proposals; see `docs/release-evidence.md` for verification. |
| Web research | OpenAI Responses API hosted `web_search` with `gpt-4.1-mini`, server-only key, over `fetch` | Cited sources and recorded token usage under daily paid-call allowances per workspace and across all workspaces (docs/DECISIONS.md). |
| Transcription | Cloudflare Workers AI Whisper (`@cf/openai/whisper-large-v3-turbo`) over REST | Server-side requests per short live chunk and per archived chunk, verified PCM encoding, source alignment and batch gap recovery. |
| Speaker attribution | pyannote Live-1 and Precision-3 cloud APIs as evaluated upgrades; Whisper returns no speaker labels | Correctable speaker tracks; names require enrollment or user confirmation. |
| Speech output | [Speech output decision](../docs/DECISIONS.md#speech-output-decision---2026-10-10) | Requested output only, with response IDs and interruptible browser playback. |
| Integrations | Pipedream Connect + Proxy/component APIs from TypeScript | One account-scoped client; search, inspect and request gateways. |
| Human authentication | `openid-client` for OIDC | Issuer selected by configuration: WorkOS AuthKit hosted, embedded Better Auth self-hosted (docs/DECISIONS.md); use verified identity plus explicit Sanctum membership. |
| Remote agents | Official `@modelcontextprotocol/sdk` TypeScript server over Streamable HTTP | Explicit tools calling the same Effect services and authorization as REST. |
| Public SDKs | Promise-based TypeScript client; thin Python HTTPX client | Generate wire types from OpenAPI; neither client requires Effect in consumer code. |
| Tests | Vitest + `@effect/vitest` + Playwright | Behavior, clocks, interruption, contracts, isolation, real MySQL and browser recovery. |
| Hosting | Docker Compose + Caddy | One Node.js application image, API and worker containers, MySQL; R2 remains external storage. |
| Repository tooling | TypeScript on Node.js + npm | Existing handoff checks use Node's test runner; extend npm workspaces during application implementation. |

The application runtime and repository tools are TypeScript.
Python is required only by consumers and tests of the promised Python SDK, not by capture, API, workers, MCP or deployment.
Use ordinary React components; keep Effect primarily in server orchestration and the browser capture controller.
Keep the public SDK on standard Promise, AbortSignal and JSON interfaces.

### Effect boundaries and version policy

Registry check on 2026-09-28: `effect` stable is 3.22.2; 4.0.0-rc.118 is a release candidate, not the selected baseline.
Use v3 documentation and lock compatible peer versions together; for example, `@effect/sql-mysql2` 0.53.0 declares `effect` ^3.22.0, `@effect/sql` ^0.52.0 and `@effect/platform` ^0.97.0.
Recheck registry metadata when implementing and record the exact tested lockfile; do not mix v4 imports with v3 packages.
No application dependency is installed merely because it appears in this blueprint.

Use `Effect.gen` for orchestration, `Schema` for boundary decoding and `Layer` only for concrete dependencies such as database, providers and clock.
Wrap provider promises with cancellation signals when supported; bound timeout, retry count, concurrency and queue capacity.
Use scoped acquisition/finalizers for sockets, timers and pool resources; release them on interruption and shutdown.
A request disconnect cancels its request work; accepted jobs remain in MySQL and belong to the worker process.
In-memory fibers, Queue and PubSub do not provide restart durability.
Keep the MySQL job ledger; do not replace it with an in-memory queue or an additional workflow/cluster framework.
Retry safe reads and classified transient failures; an external write with an ambiguous outcome becomes `unknown` for reconciliation.
Typed failures improve control flow but do not enforce permissions, prove grounding, or make side effects exactly once.

Effect Schema defines wire contracts once, then HttpApi exports OpenAPI and shared services decode all inputs.
Use only JSON-representable wire types; domain-only transforms stay behind the wire schema.
Adapt MCP SDK validation requirements at its boundary and test JSON Schema equivalence; do not maintain a second independently edited business schema.
The SDK's required Zod boundary dependency is acceptable; it must not become a second domain model.

### Performance contract: optimized TypeScript, measured against Rust

Treat workload-specific Rust parity as an engineering target, not a property supplied by TypeScript or Effect.
Preserve an all-TypeScript application; benchmark-only Rust reference code is not an application dependency.
Do not add native extensions, a Rust service or WebAssembly to make a failed TypeScript comparison disappear without an explicit architecture decision.

Keep the data path small:

- Decode PCM with Buffer, Uint8Array, Int16Array and DataView; keep binary payloads binary instead of base64 or JSON arrays.
- Reuse bounded buffers where profiling shows allocation pressure; define ownership and lifetime before sharing views or transferring ArrayBuffers.
- Never overwrite a buffer while an asynchronous socket, recording writer or worker still owns its bytes; account for detached buffers after transfer.
- Validate every untrusted frame's header, byte length, source range and authorization, then pass the decoded representation without repeating expensive full-schema transforms at each internal call.
- Put Effect around sessions, batches, provider requests and durable jobs; keep sample loops and waveform drawing as plain typed-array code, without per-sample fibers, effects or schema objects.
- Keep AudioWorklet callbacks free of logging, network calls, database work and unbounded allocation; move formatting and asynchronous work outside the audio callback.
- Keep waveform samples outside React state and update Canvas through requestAnimationFrame; React receives low-rate semantic state changes only.
- Bound every queue, cache, pool and batch by bytes/items and define overload behavior; never trade silent audio loss or false archive acknowledgements for benchmark speed.
- Use streaming I/O and scoped database queries; inspect query plans, avoid N+1 reads and avoid repeatedly serializing full transcripts or copying whole recordings.
- Keep CPU-heavy ranking/resampling/assembly away from live ingest; introduce a fixed-size worker-thread pool only when profiles justify it, never a new worker per frame or request.
- Preserve numeric precision, tenant isolation, cancellation, source fidelity and action idempotency while optimizing.

Benchmark the application before claiming parity:

1. Commit deterministic synthetic fixtures and a machine-readable workload manifest: hardware, OS, Node/V8 and Rust/compiler versions, release flags, CPU/RAM limits, frame format/rate, payload sizes, dataset size, concurrency, cache state and durability semantics.
2. Exercise the same work in both implementations: PCM decode/validation/dispatch, transcript ingest, scoped context reads/writes, archive streaming, and exact cosine ranking with the same algorithm and numeric precision.
3. Compare the actual Effect service path with a competent Rust release build, including equivalent auth, validation, queue bounds, database operations and completion semantics; do not compare a full service against an echo handler.
4. Use deterministic provider stubs to isolate application overhead; run separate live-provider tests and report provider latency separately so network waits cannot hide a slow runtime.
5. Measure cold start and steady state separately, warm V8 before steady-state sampling, repeat runs, and record throughput, p50/p95/p99 latency, error rate, dropped samples, CPU, RSS, heap/external-buffer memory, GC time and event-loop delay.
6. Sweep offered load through saturation and test slow consumers and reconnect storms; measure from scheduled arrival time so stalled clients cannot hide tail latency by sending less work.
7. Proposed starting parity tolerance: at least 90% of Rust throughput and no more than 110% of Rust p95/p99 latency at the same offered load, with identical correctness/error criteria and declared CPU/RAM limits.
8. Report each workload separately, including CPU/RSS ratios and statistical variation; do not call the whole application Rust-equivalent because one I/O test is close.
9. Commit baseline results, fixture hashes and reproduction commands; investigate regressions from profiles, make the smallest justified change, then rerun correctness and performance checks.

The 10% tolerance is a proposed initial engineering gate, not measured performance or a universal Rust-equivalence threshold.
Capacity and absolute latency/memory budgets must name their reference hardware and workload in the benchmark manifest before results can pass; missing configuration is an explicit unrun gate.
Use Node perf_hooks and CPU/heap profiles for diagnosis; Effect concurrency does not move synchronous CPU work to another thread.
During the 24-hour soak, queue depth and retained memory must remain within configured bounds and return toward baseline after work drains.
Run deterministic benchmark correctness/smoke checks in ordinary CI; use a controlled machine for comparative performance gates because shared hosted-runner timings vary.
No benchmark result exists in this handoff; parity remains unverified until the application and matched reference run.

### Browser listener

Create the React/Vite website and browser `navigator.mediaDevices.getUserMedia` microphone access.
Production microphone access requires HTTPS and user permission; localhost is suitable for development.
The room computer and laptop open the same URL, choose an authorized workspace and microphone, and start listening.
No installed app or installation step is needed.

Keep the capture controller above the review-overlay/router lifecycle so opening Notes, Agents, or Settings does not recreate the microphone stream.
Use one browser AudioWorklet-to-WebSocket live media path.
Use Web Audio for the recreated waveform and a bounded recording tap, with IndexedDB for pending-upload recovery data.
Keep credentials in a secure browser session; provider/R2/Pipedream secrets remain server-side.

The capture tab must stay open and the device must remain awake for continuous microphone capture.
A hidden tab may continue recording when the browser permits it, but browser suspension, discard, process exit, or OS sleep can interrupt it.
Do not promise native-style background recording or capture after tab close.
Service workers are not a substitute for a live microphone document.
Offer Screen Wake Lock where supported during active visible capture, handle rejection/release, and re-request when visible again if the user still wants it.
Wake Lock does not override lid closure, user sleep, or every browser/OS policy.

### One application image, two entrypoints

The API entrypoint serves Effect HttpApi at `/api/v1`, `/mcp`, authenticated live ingest and built website assets on one HTTP server.
Delegate `/mcp` to the official SDK transport and live upgrades to the scoped WebSocket handler; all adapters call the same domain services.
Use `ws` for server WebSocket upgrades on the Node server; verify integration with the pinned Effect Node HTTP implementation instead of adding a second framework or port.
The worker entrypoint runs context, final notes, recording assembly, batch transcription/diarization, memory, matching and authorized actions from the same image.
Run API and worker as separate processes/containers with separate process-scoped resource layers and bounded pools.
Already accepted jobs continue after the browser closes or the API restarts.
Do not add Redis, Kafka, Temporal, a vector service or a separate media image for this version.
MySQL is the only structured production database.

### Live media and speech ownership

Implement concrete TypeScript adapters for Workers AI Whisper, the [selected speech output provider](../docs/DECISIONS.md#speech-output-decision---2026-10-10), and optional pyannote cloud APIs.
A socket connection ID identifies a transport attempt, never a meeting or speaker identity.
For each provider request or connection, persist the source epoch/track/sample anchor and offset used to align returned timestamps.
Whisper has no connection: each live chunk is one request anchored at its first sample, and its segment times are relative to the chunk.
A pyannote socket starts a new offset mapping on reconnect, while the application capture epoch can remain unchanged.
Apply provider keepalive and rotation rules from current documentation and release the socket when capture stops.
Business work enters the durable job ledger; closing a socket never discards accepted work.

Replacing the earlier media framework requires explicit tests for end-of-turn detection, output interruption, echo protection, bounded playback queues and reconnect.
Effect manages these lifecycles; it does not supply an audio codec, speech detector or conversation policy.
Use browser echo cancellation where supported and record assistant playback ranges; never treat generated speech as a fresh user request.
Each permitted spoken response carries a request ID and cancellation generation checked by both server and browser before emitting audio.
On user interruption, pause, disconnect or expired speech window, abort generation/TTS, stop current playback and discard queued chunks from the old generation.
Reconnection must not resume an old spoken response automatically.
Default listening, research and post-meeting completion remain silent.

### Storage

MySQL owns identity scope, meetings, transcript/source pointers, selected context, jobs, integration accounts, grants, and receipts.
R2 owns private audio objects and assembled per-meeting playback files.
Development/test uses an isolated MySQL 8.4 container with a dedicated volume; production connects to the chosen MySQL host.
Define backups and recovery before cutover; adding a MySQL target does not authorize provisioning a paid service.
IndexedDB holds pending browser uploads and recovery metadata, subject to browser quota and eviction policy.
Only acknowledged R2 objects with manifest records count as remotely saved recordings.
Pipedream owns external app credentials and supported integration execution.

## 05. Browser capture, handoff, and recovery

### Listener identities and ownership

Register a browser listener under an authenticated workspace and principal.
Persist a listener/device identifier in origin storage, while accepting that browser storage can be cleared.
A capture epoch identifies one continuous sample clock; network reconnect alone does not need to create another epoch.
A page reload, device change, or stopped/recreated microphone stream creates a new epoch and records its gap/transition.
Record source track, sample rate, sample offset, captured-at UTC, local timezone, and server-received-at separately.
Derive elapsed time from monotonic/sample clocks, not wall-clock subtraction.

Prevent accidental duplicate recording by tabs in the same browser using browser coordination where supported plus an authoritative server lease.
Use capture-group leases only when room and laptop listeners intentionally represent the same meeting.
Bind a group through an explicit room assignment, approved calendar identity, or meeting join operation.
Do not merge different meetings merely because they overlap in time, mention the same company, or sound similar.
A configured room listener can be preferred; an already open, permissioned laptop listener can take over when its ownership policy allows it.
The server cannot remotely activate a closed tab or bypass the browser microphone permission flow.
Use an incrementing ownership generation to reject stale live-state writes after handoff.
Retain overlapping evidence for reconciliation and avoid issuing duplicate actions.

### Live path

The user starts listening through an explicit control, then grants microphone permission if needed.
Handle permission pending/denied, no matching input, hardware errors, and unsupported constraints separately.
Connect the same microphone stream to the waveform analyser and AudioWorklet recording/live tap.
After a successful authenticated WebSocket upgrade, send a validated versioned `start` message with listener, epoch, track, sample rate, channels, encoding, clock anchor and ownership generation.
Wait for an accepted response before streaming audio.
Use PCM16 little-endian payloads with an explicit binary frame header containing protocol version, sequence, sample start and sample count; reject malformed size/range/rate changes.
Document byte layout and maximum frame size in the shared wire contract before implementation; test encode/decode against independent fixtures.
A 20–100 ms live frame is an initial tuning range, separate from the 30-second archive chunk.
Use safe integer ranges or decimal strings for counters at JSON boundaries; never silently round a 64-bit source position.
Validate listener authorization, epoch and lease ownership on every control operation and before accepting source frames.

Bound browser `WebSocket.bufferedAmount`, queued PCM bytes, server backlog and provider send backlog.
If live ASR cannot keep up, mark the live range pending/degraded and recover it from independently uploaded recordings; never create an unbounded backlog or label it transcribed.
Recording-buffer exhaustion still pauses capture rather than silently discarding archive data.
A socket acknowledgement means accepted for live processing, not saved in R2.
Track live acceptance, final transcript coverage and durable archive coverage separately.
Map ASR offsets back to epoch/sample ranges and test drift, reconnect, duplicated frames, gaps and resampling against known fixtures.
Use source timestamps/sample ranges as durable identities rather than append time or a socket ID.

Persist final transcript segments and source watermarks continuously.
Partial ASR text can appear visually but is not a committed fact and must not trigger irreversible actions.
Requested speech still uses the audio output path through the request-only speech gate.

### Browser recovery buffer

Use an AudioWorklet/recording tap to produce PCM and independent WAV archive chunks; record the actual sample rate and implement any required conversion explicitly.
Commit pending chunk/journal records to IndexedDB in bounded transactions instead of retaining an entire meeting in JavaScript memory.
Use `navigator.storage.estimate()` to monitor available capacity and optionally request persistent storage with `navigator.storage.persist()`.
A request for persistence can be denied; quota, clearing, and browser eviction remain real failure modes.
Do not describe an IndexedDB commit as a guaranteed filesystem fsync or promise zero data loss after browser/OS failure.

Upload chunks while the page remains active through the authenticated backend upload endpoint.
Validate listener ownership, range, size, and hash before writing to R2.
Provider credentials never enter browser code.
A repeated chunk ID with the same hash returns the original receipt; a different hash returns a conflict.
Remote acknowledgement requires both the R2 object and the database manifest.
If R2 succeeded and the database write failed, a retry reconciles the object and completes its manifest.
Remove a browser-buffered chunk only after the remote receipt is stored locally.

When the page reloads, recover pending records if browser storage is still available and the user can authenticate to their owning workspace.
Never upload another signed-in user's pending data under a new account merely because the browser is shared.
If storage is missing, full, or inaccessible, expose the missing/pending range and pause or degrade honestly.
Keep states distinct: capturing, buffered locally, uploading, saved remotely, interrupted, and missing.

### Offline and transcript reconciliation

While the page remains active, capture offline into the bounded recovery buffer.
Once quota is exhausted, stop visibly rather than erase earlier unuploaded audio.
After reconnect, upload pending chunks and batch-transcribe ranges without final live transcription.
Reconcile epoch/track/sample ranges to avoid duplicate text when live ASR later returns.
Do not replay archived audio through room speakers or rerun completed external actions.

### Input scope and audio validity

The initial website version captures the selected microphone only.
Do not add mandatory screen sharing or claim access to all laptop/system audio through microphone permission.
If system audio becomes a later requirement, design it as a separate explicit browser-supported capture flow.
Keep Sanctum's generated speech timing distinguishable so echo cannot become a new human request.
Use independent valid WAV files initially; arbitrary MediaRecorder WebM fragments cannot be assumed to concatenate into a valid recording.

### Pause, close, sleep, and resume

Pause stops microphone tracks after checkpointing available buffered data; resume reacquires permission/stream as needed and creates a fresh epoch.
Closing a review overlay leaves capture running.
Closing the tab/browser stops capture; do not rely on `beforeunload` or `sendBeacon` to save the final large audio buffer.
Use continuous commits/uploads and server heartbeats so the last confirmed range is already known.
The server marks a disconnected listener interrupted after its lease expires, while accepted jobs continue.
On visibility return or reconnection, inspect the actual track/connection state, recover pending uploads, and show an explicit resume control when capture must restart.
Record sleep/discard gaps instead of treating the whole elapsed interval as recorded audio.

## 06. Meeting state and boundary correction

Maintain separate listener, meeting, processing, and action state.
Listener states: stopped, starting, listening, reconnecting, paused, degraded.
Meeting states: provisional, active, closing, closed, interrupted.
Processing state tracks transcript coverage, notes readiness, memory commit, and recording completeness independently.

Start a provisional conversation after coherent speech appears.
Promote it to an active meeting when continued speech or explicit context establishes a conversation.
Use a small boundary decision schema: continue, start, close, or split; include source ranges, evidence, reason, and uncertainty.
Available signals include conversation gaps, explicit starts/ends, speaker changes, calendar hints when authorized, and topic continuity.
A topic change or a silence timeout alone does not justify a hard boundary.
Keep low-confidence boundaries provisional and expose a correction control in Review.

A close operation first seals the meeting's source range and persists its terminal capture watermark.
It then schedules final transcription reconciliation, notes, diarization refinement, and memory commit.
The listener stays active and can open the next meeting while previous jobs finish.
Closing never queues a spoken sign-off.

Split/merge is a transactional source-range reassignment with a boundary revision and audit event.
Use half-open source intervals so a sample/word has one canonical meeting owner for a revision.
Rebuild derived summaries and invalidate context snapshots after a correction.
Do not delete original sources or replay prior side effects.
Preserve action IDs and original receipts; link them to revised meeting context without claiming they executed again.
Meetings with incompatible permissions cannot merge unless an authorized user first resolves access explicitly.
Prevent old recording URLs from exposing audio outside the revised boundary: assembled files are revisioned, and new URLs reference the current allowed cut.
Existing signed URLs remain usable until expiry, which is why their lifetime is short.

## 07. Proposed data model

Use UUIDs for public identifiers and enforce workspace ownership on every reference.
Use `DATETIME(6)` in UTC for new wall-clock fields, store IANA timezone separately, and retain integer sample offsets for audio ranges.
Set every database connection to UTC and decode UTC timestamps through the TypeScript boundary; MySQL DATETIME does not store a timezone.
Use native `JSON` for typed payloads, not as a substitute for ownership columns or uniqueness constraints.
Use explicit case-sensitive/binary collation for identifiers and idempotency keys; choose and test text-search collation separately.
Use `utf8mb4` for human text, bounded indexed identifier columns, and matching column types for composite ownership foreign keys.
Every owned table includes `workspace_id`; cross-table references must enforce matching workspace ownership.

| Table or change | Required fields and invariants |
| --- | --- |
| `workspaces` | ID, name, IANA timezone, context event counter, permission revision, configured capture/retention policy. |
| `principals` + `workspace_members` | Human/agent/device principal; verified issuer/subject or credential identity; explicit workspace membership and role. Never infer membership from an email domain. |
| `meetings` | Workspace, listener/group, lifecycle state, title, start/end UTC, boundary revision, source coverage, notes JSON/revision, processing state. Use a meeting-native schema. |
| `meeting_access` | Session/principal or approved workspace-visible scope; restrictive default until ownership is explicitly assigned. |
| `listeners` | Device identity, mode, selected sources, heartbeat, lease owner/generation, current capture epoch, browser capabilities, health. |
| `recording_chunks` | Epoch/track/sequence, sample start/count/rate, UTC anchor, byte length, SHA-256, R2 object key, upload state. Unique source identity; hash conflicts return 409. |
| `meeting_ranges` | Meeting/source intervals plus boundary revision; used for split/merge and safe audio assembly. |
| `transcript_segments` | Immutable source range, text, speaker track, ASR provenance, partial/final status, transcription revision. Corrections create revisions rather than erasing evidence. |
| `speaker_tracks` | Provider stream/label, source ranges, optional verified person mapping, attribution revision and confidence when supplied. Label IDs never imply identity across stream restarts. |
| `voice_enrollments` | Optional explicit enrollment, principal/workspace scope, provider reference, consent/version/revocation metadata. Never expose voiceprints through ordinary context reads. |
| `profile_embeddings` | Workspace/profile/kind, embedding model, dimension, normalized float32 bytes, source revision. Support needs/offers matching; reject zero/invalid/mismatched vectors. |
| `context_items` | Stable item ID, immutable revision, kind, content, source refs, event/validity times, author, scope, provisional/committed/superseded state, supersedes pointer. Unique item/revision. |
| `context_events` | Workspace sequence, meeting/item IDs, change kind, actor, source revision, permission revision, timestamp. Written atomically with the context change. |
| `agent_credentials` | Credential hash, owner, allowed workspaces/meetings/scopes, expiry, revocation, last use. Plain tokens returned once, never stored or logged. |
| `integration_accounts` | Stable owner identity, Pipedream external user/account IDs, app slug, workspace, status, owner and workspace mapping. |
| `action_grants` | Grant owner, action/app/account scope, exact resource/recipient restrictions, expiry/revocation, version. A prompt cannot create a grant. |
| `actions` | Canonical action ID, meeting/workspace, request idempotency key, normalized args hash, grant/version, execution state, provider receipt, attempt metadata, reconciliation state. |
| `jobs` | Kind, ownership/source revision, unique work key, status, available-at, lease token/until, attempts, result/error. One pending coalesced context job per meeting. |

Use an InnoDB row lock when incrementing each workspace's context-event counter and append the event in the same transaction.
This produces a committed order for change cursors; a bare global sequence allocated before commit can otherwise expose holes to readers.
Use `expected_revision` for context edits and boundary corrections; reject stale writes with the current revision.
Do not use fuzzy task hashes as the only idempotency guarantee for money, email, calendar, or other external writes.
Keep heuristic dedupe as a suggestion layer above stable action IDs and receipts.

### MySQL-specific SQL and job semantics

Use MySQL 8.4 LTS as the selected baseline and pin a supported patch during implementation.
All transactional tables use InnoDB.
Use `@effect/sql-mysql2` with bounded pool capacity and acquisition deadlines; decode returned rows using Effect Schema.
Configure mysql2 date/number handling deliberately: preserve DATETIME(6) microseconds as UTC strings and unsafe BIGINT/DECIMAL values as validated strings instead of JavaScript Number.
A JavaScript Date only preserves milliseconds; use it only where that precision is sufficient.
Normalize JSON, boolean, buffer and null handling at one database boundary.
Use scoped transactions and connection cleanup on success, failure, cancellation and shutdown.
Do not hold transactions open while waiting on model or provider calls, and do not block the audio event loop with unbounded synchronous ranking or audio assembly.

Claim jobs inside a short transaction using `SELECT ... FOR UPDATE SKIP LOCKED`, then write owner/lease/generation and commit before calling a model or provider.
Use an index beginning with eligible status and available time; verify the actual query plan and lock behavior under concurrent workers.
Use SKIP LOCKED for the queue, not for consistency-critical context reads.
Fence completion updates by the acquired lease generation and retry deadlocked database transactions with a bounded policy.
Do not retry an external side effect merely because its subsequent database transaction failed.

Use MySQL-native SQL:

- Replace `ON CONFLICT` with `INSERT ... ON DUPLICATE KEY UPDATE` using supported row aliases, or an explicit no-op insert path with the intended uniqueness semantics.
- Replace `ILIKE`, `ANY`, `::jsonb`, `::timestamptz`, JSONB operators/functions, and Postgres regex/date syntax with tested MySQL equivalents or explicit TypeScript transformations.
- Prefer normalized participant/access relations for indexed ownership/person lookups; native JSON remains appropriate for typed document payloads.
- Replace GIN/HNSW/pgvector-specific indexes and operators rather than leaving hidden Postgres dependencies.
- Test null ordering, Unicode, case/accent behavior, timezones, booleans, JSON null, empty lists, and duplicate-key behavior against synthetic behavior fixtures.
- Do not assume MySQL DDL can be rolled back as a multi-statement transaction: schema operations can implicitly commit.
- Use a migration ledger, an execution lock, explicit preconditions, and restart-safe steps; inspect partial completion before retrying.

[MySQL locking reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html), [upserts](https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html), [implicit commits](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html), [Effect MySQL client](https://effect.website/docs/v3/api/sql-mysql2/MysqlClient).

## 08. Time-aware context and selective memory

Context input contains current UTC, workspace timezone, capture/event time, ingestion time, meeting start/elapsed time, confirmed participants, recent final transcript, current decisions, open questions, authorized prior memory, and action receipts.
Resolve relative time expressions against the utterance's event time in its meeting timezone.
Preserve the original phrase, normalized time, anchor, and ambiguity.
Do not resolve a delayed recording's "tomorrow" against the day the background job runs.
Ambiguous dates must remain unresolved for actions that require exact scheduling.

Build context from bounded new evidence plus the current working snapshot.
Persist the last processed source watermark; retries with the same input revision are idempotent.
Allow one context job to run at a time per meeting, and coalesce arrivals while it runs.
A slow model must not block capture or produce an unbounded queue of stale summaries.

Suggested fact kinds: decision, commitment, constraint, project fact, preference, open question, research observation.
Each candidate cites exact transcript segment IDs or external source artifacts.
Validate that source IDs exist, are authorized, and support any verbatim quote before committing.
Keep model-derived inferences distinguishable from spoken facts and human corrections.
Extracted commitments do not become executed tasks without a matching action grant.

Reuse Jcyber's separation between source evidence, selected atoms, working context, and durable knowledge.
Do not reuse its current SQLite stub as a shared production service: it retrieves one JSON payload by engagement key and ignores supplied scope.
Use MySQL FULLTEXT for lexical context search, with explicit fallback behavior for short terms and supported languages.
Implement semantic people/needs/offers matching: store embeddings with model/dimension metadata in MySQL, then compute exact cosine top-k in bounded TypeScript batches over Float32Array values.
Apply workspace/access filters before loading vectors, and stream batches rather than loading every tenant into a global matrix.
This is O(N × dimensions), not an ANN index; measure latency, recall, memory and event-loop delay at the configured directory size and agreed growth target.
Run ranking in the worker, yield between bounded batches and move CPU-heavy work to a worker thread only if the measured budget requires it.
Do not silently drop semantic matching or replace it with keyword-only search.
If exact ranking fails the measured scale target, flag that result and choose a separately approved vector index before claiming parity.
Always apply access scope in retrieval queries before data reaches the model.
Cache context using workspace, meeting, principal access fingerprint, permission revision, and source/context revision.
Never use a global `state:all` cache for tenant data.

At meeting close or explicit checkpoint, distill settled facts into committed memory.
Keep active meeting context available to agents before final commit.
One canonical structured summary feeds notes, email discussion sections, and exports; tool receipts provide action outcomes.
Failures retain the full sources and expose pending/failed status instead of activating demo heuristics.

## 09. Model and speaker pipeline

### LLM roles

| Role | Initial implementation choice | Gate |
| --- | --- | --- |
| Requested voice response | Workers AI `@cf/qwen/qwen3.8-27b` (OpenAI-compatible chat completions), thinking disabled, short streamed response. | Compare first audible response and tool fidelity against labeled behavior fixtures. |
| Notes and memory extraction | Same Workers AI Qwen model, strict `json_schema`, low reasoning. | Grounding, omissions, contradictions, names, and date resolution. |
| Planner | See the planner provider decision in `docs/DECISIONS.md`. | No unauthorized action or material regression in labeled fixtures; see `docs/release-evidence.md` for verification. |
| Research executor | OpenAI Responses `web_search` with GPT-4.1-mini, chosen 2026-10-10 (docs/DECISIONS.md); Anthropic hosted search stays selectable. | The planner decides when to research; each paid call passes the daily allowance first and records usage. |
| Speech transcription | Workers AI Whisper, with explicit model/version; live audio in short chunks. | Word timing and recall on actual room/laptop audio. |
| TTS | See the [speech output decision](../docs/DECISIONS.md#speech-output-decision---2026-10-10). | All output must pass the request-only speech gate. |

Make provider/model selection explicit by role; do not select a provider merely because its API key happens to exist.
Use small concrete client functions and validated result models, not a universal agent framework.
Missing keys or provider errors must produce visible failures, never invented notes or successful mock actions.
Pin the selected model ID and record it with generated artifacts for reproducibility.
Add bounded retries for transport/rate-limit failures; do not retry malformed factual output indefinitely.

### Speaker attribution

Implement structured speaker tracks before adding another diarization provider.
Benchmark pyannote Live-1 on real room audio before enabling it; Whisper supplies no diarization.
Use Precision-3 for a later correction pass over complete recordings if its measured improvement justifies the additional call.
Keep ASR and diarization sample-time alignment explicit, including provider-stream offsets.
Record supported streaming/batch diarization versions, idle timeout, maximum stream duration and keepalive behavior from each provider during implementation.
Rotate streams before the verified limits and preserve application meeting IDs; provider limits belong in tested adapter configuration, not timeless assumptions.
Do not carry `SPEAKER_00` across streams as if it identified a person.

Use explicit enrollment or user-confirmed mappings for names.
Prefer an unknown speaker over a false name when evidence is weak.
A voice match is evidence for attribution, never authentication for SDK, MCP, or Pipedream actions.
Record attribution corrections so notes/memory can be recomputed without rewriting raw audio.

Google voice replication is an optional future output-voice choice, not a speaker-identification dependency.
It is excluded from the critical path of this revamp unless the user separately chooses a custom assistant voice.

## 10. Pipedream and authorized execution

Implement one Pipedream client shared by API and worker operations.
Support raw-byte Drive uploads, distinguish upstream errors, cache status safely, and enforce stored recipient restrictions.
Use stable workspace/member connection identities, with explicit account selection for each meeting.
Never silently reuse the last room occupant's connected account.

### Progressive tool discovery: three fixed integration tools

The model receives three Sanctum integration gateway definitions, not hundreds of Pipedream tools.
Pipedream's component catalog stays server-side and is queried only when a task needs an integration.
These gateway names are Sanctum's proposed API, not claims about Pipedream's native tool names.

| Gateway | Model supplies | Model receives |
| --- | --- | --- |
| `search_integration_actions` | Intent, optional app filter, bounded limit. | At most five compact matches: action ID, app, one-line purpose, connection state, and effect category. No parameter schemas yet. |
| `get_integration_action` | Selected action ID, partial configuration, and optional field/options cursor. | The selected operation's versioned input requirements, required fields, relevant account-bound options, and any missing configuration. |
| `request_action` | Selected action ID, validated configuration reference/version, arguments, meeting scope, and idempotency key. | Persisted action ID and status; actual execution follows the same grant/receipt path as other actions. |

Example: a request to create a tracking issue first searches for that intent, inspects the single chosen issue-creation action, and submits its arguments.
Other apps and their schemas never enter this task's prompt.
If the selected operation is already known and its schema is current, reuse its task-local configuration and skip discovery.

Enforce prompt-size boundaries in code:

- Keep MCP `tools/list` and internal LLM tool definitions independent of catalog size: eleven core tools in this plan, including the three integration gateways.
- Search defaults to three matches and has a hard maximum of five; return compact metadata only and a refinement hint when no match is useful.
- Search connected and permitted apps by default; an explicit request for an unconnected app can return a connection-required hint without enabling execution.
- Load schema/configuration for one selected action at a time; page remote options and large optional-field sets instead of returning every channel, project, contact, or folder.
- Keep full authoritative validation server-side; mark paged schema/configuration responses as incomplete until required configuration is resolved.
- Bound discovery/configuration output by a configurable byte/token budget; if a necessary schema cannot fit safely, return a structured configuration-required result rather than silently truncating it or dumping the catalog.
- Cache public component metadata by version; cache account-dependent configuration by principal, workspace, account, and connection/permission revision.
- Revalidate component version, final arguments, account access, and action grant before execution; discovery is not authorization.
- Do not append catalog results or every visited schema to durable meeting context. Persist concise receipts/artifact references and keep selected tool details in the current task only.
- Bound large action results too; return a receipt/summary and a scoped artifact reference for further reading.

Use Pipedream's documented component search/configuration/execution APIs underneath these gateways.
Resolve dynamic props and account-specific option IDs before submission; do not make the model invent identifiers.
Do not connect the full Pipedream MCP catalog directly to every model turn or register one Sanctum tool per integration.
The complete catalog remains searchable without fixed Google-only task enums.

Acceptance: a fixture with 10,000 catalog entries still produces the same eleven-tool MCP list, no more than five discovery hits, and only the selected action's configuration in task context.
Test missing connections, large option lists, schema changes, stale configuration, revoked grants, and oversized results.
[Pipedream discovery/configuration reference](https://pipedream.com/docs/connect/components).

All work enters one action gateway: authenticate actor, authorize meeting, resolve account, validate operation/schema/arguments, match a stored grant, establish idempotency, persist request, then execute.
Use a broad operation string plus validated provider schema for the long tail; preserve concrete handlers for Gmail, Calendar, Drive, research, and matching behavior.
Never accept arbitrary target URLs or supplied account IDs as authority from model output.

Execution states: proposed, awaiting_authorization, queued, running, succeeded, failed, unknown, cancelled.
A timeout after request submission is `unknown` until reconciled, not automatically failed-and-retryable.
Use provider idempotency keys where supported.
Where an operation has no idempotency/reconciliation mechanism, stop automatic replay after an ambiguous result and require resolution.
Do not promise exactly-once behavior across every third-party API.
Store provider receipts and actual artifacts separately from model summaries.
Check grant revocation/version again immediately before a queued external write.
Post-meeting completion updates context/activity silently.

## 11. Identity, authorization, and isolation

Add an authenticated human/workspace model before exposing multi-team context or SDK/MCP writes.
Pipedream action linking is separate from user authentication.
Use a maintained OIDC client and verified issuer, audience, signature, expiry, state, and PKCE handling.
The issuer is any standard OIDC issuer selected by configuration: WorkOS AuthKit hosted, embedded Better Auth self-hosted (docs/DECISIONS.md); keep login scopes and client separate from Pipedream's action credentials.
Membership is stored explicitly; a matching email domain or spoken company name grants no access.

Use browser sessions in secure HttpOnly cookies with CSRF protection for mutations.
SDK automation uses revocable hashed tokens bound to a principal, workspace/meeting allowlist, and scopes.
Remote MCP uses delegated OAuth and the same authorization functions.
Use the official TypeScript MCP SDK authorization interfaces with a maintained authorization server that supports the selected protocol's resource/audience requirements.
The same providers are the authorization servers (docs/DECISIONS.md); do not implement a custom OAuth server or assume human-login ID tokens are Sanctum MCP access tokens.
Publish protected-resource metadata and test issuer discovery, PKCE, resource audience, scopes, expiry and revocation with the selected server.
Verify the issued access token and map its validated subject to a Sanctum principal; durable grants and credentials live outside process memory.
Do not forward arbitrary upstream OAuth tokens as Sanctum API credentials.

Minimum scopes: `context:read`, `context:write`, `recordings:read`, `actions:request`, `actions:execute`, `workspace:admin`.
A write-capable agent does not automatically get recordings or action execution.
Device ingest credentials are narrower than human or agent credentials.
Authenticate the WebSocket upgrade with the same-origin secure browser session and an explicit Origin allowlist; reject missing or unexpected browser origins.
Require CSRF protection on HTTP session/device mutations; bind the socket to the authorized listener and ownership generation after the start handshake.
Recheck permission revision, session expiry and lease revocation during long-lived capture; close unauthorized connections.
Do not place credentials in socket URLs, subprotocol strings, control messages or logs.

Enforce scope in REST, MCP, background workers, caches, exports, search, and signed audio access.
Replace global live-state reads with authorized workspace/listener views.
Keep authorization consistent across every route and background operation.

## 12. API contract

Use one Effect HttpApi `/api/v1` contract with explicit operation IDs and JSON-representable Effect Schema wire models.
Keep existing proposed wire fields in snake_case for contract consistency; TypeScript method names may be idiomatic without inventing a second data model.
List endpoints use opaque cursor pagination and bounded limits.
A missing or unauthorized resource returns the same outward result where revealing existence would leak data.
Standard errors include code, message, request_id, retryable, and typed details without secrets.

| Method and route | Behavior | Access |
| --- | --- | --- |
| `POST /api/v1/listeners` | Register a room/laptop device and its source capabilities. | Device enrollment / admin |
| `GET /api/v1/listeners/{id}/stream` (WebSocket upgrade) | Session/Origin authorization, versioned start handshake, bounded PCM and control frames, provider-offset mapping. | Authorized browser listener |
| `POST /api/v1/listeners/{id}/heartbeat` | Update health and renew the capture-group lease. | Device ingest |
| `PUT /api/v1/listeners/{id}/chunks/{chunk_id}` | Validate/upload a bounded audio chunk and return a durable receipt. | Device ingest |
| `GET /api/v1/meetings` | Filter accessible meetings by date, participant, status. | Context read |
| `GET /api/v1/meetings/{id}` | Lifecycle, processing watermarks, source coverage, revision. | Context read |
| `POST /api/v1/meetings/{id}/close` | Seal source boundary and enqueue final work; listener remains active. | Authorized meeting mutation |
| `POST /api/v1/meetings/{id}/split` | Revision-checked range split with audit record. | Authorized meeting mutation |
| `POST /api/v1/meetings/merge` | Revision-checked merge after access compatibility validation. | Authorized meeting mutation |
| `GET /api/v1/meetings/{id}/transcript` | Paginated final segments and requested revisions. | Context read |
| `GET /api/v1/meetings/{id}/context` | Bounded, source-linked snapshot and its revision. | Context read |
| `GET /api/v1/context/search` | Authorized text/optional semantic retrieval. | Context read |
| `POST /api/v1/context/items` | Add attributed evidence, observation, or memory candidate. | Context write |
| `PATCH /api/v1/context/items/{id}` | Add a revision/supersession; require expected revision. | Context write |
| `GET /api/v1/context/changes` | Return durable application changes after a cursor. | Context read |
| `GET /api/v1/sources/{id}` | Read exact cited text/source metadata. | Source's access scope |
| `POST /api/v1/meetings/{id}/recording-access` | Issue short-lived URL for an authorized audio cut. | Recordings read |
| `POST /api/v1/meetings/{id}/requests` | Explicit human/agent question; speech requires separate allowed output intent. | Context read/request |
| `GET /api/v1/integrations/actions` | Return at most five compact Pipedream action matches without schemas. | Allowed connector discovery |
| `POST /api/v1/integrations/actions/{id}/schema` | Resolve one action schema, dynamic configuration, and paginated options in the actor/account scope. | Allowed connector discovery |
| `POST /api/v1/actions` | Validate, authorize, persist, and enqueue requested work. | Actions request; execution grant |
| `GET /api/v1/actions/{id}` | Return actual status and receipt. | Owning scope |
| `POST /api/v1/agents` | Create an agent principal and scoped credential. | Workspace admin |
| `DELETE /api/v1/agents/{id}/credentials/{key_id}` | Revoke a credential and invalidate cached access. | Credential owner/admin |
| `GET /healthz` and `GET /readyz` | Process health and dependency readiness without tenant content. | Operational policy |

The adapter for SDK/MCP reads the same service functions as the UI.
Do not auto-expose every HTTP route as an MCP tool: admin, capture, and destructive routes require deliberate inclusion.

### Context response example — proposed contract

```json
{
  "meeting_id": "meeting-uuid",
  "revision": 42,
  "as_of": "2026-09-26T17:24:00Z",
  "timezone": "America/Los_Angeles",
  "source_watermark": {"epoch_id": "epoch-uuid", "sample_end": 23040000},
  "items": [
    {
      "id": "context-item-uuid",
      "revision": 1,
      "kind": "decision",
      "text": "Keep pilot access limited to the current test group.",
      "state": "committed",
      "event_at": "2026-09-26T17:08:16Z",
      "author": {"type": "system", "id": "extractor-principal"},
      "sources": [{"segment_id": "segment-uuid", "start_ms": 496000, "end_ms": 501000}]
    }
  ],
  "changes_cursor": "opaque-cursor",
  "truncated": false
}
```

The values above are examples, not production data.
For a requested historic time, filter both event/validity time and revisions known by that time; expose unresolved conflicts rather than fabricating one answer.

## 13. SDK and MCP delivery

Create TypeScript and Python packages over the same OpenAPI schema.
Ship generated DTOs plus small handwritten helpers for pagination, context snapshots, retries, changes, and action receipts.
Avoid a framework dependency in consumers beyond a normal HTTP client.
Provide a Promise-based TypeScript client with AbortSignal support and a thin Python HTTPX client with sync/async helpers where justified by consumers.
Python SDK generation and tests are isolated from application runtime images; consumers never need to install Effect.
Document timeouts, cancellation, rate limiting, idempotency, and conflict recovery.

A successful SDK write accepts an idempotency key and returns the created item/action and revision.
Retried reads are safe; retried writes require the same key and payload hash.
409 conflicts include the current revision and do not silently overwrite another agent's contribution.
Changes cursors belong to the application, carry access scope, and have a documented reset response when expired or invalidated.
A revoked permission must invalidate access even if the caller has an old cursor or cached snapshot.

Example target SDK experience:

```typescript
const context = await sanctum.context.get({ meeting_id });
const result = await sanctum.context.add({
  meeting_id,
  expected_revision: context.revision,
  kind: "research_observation",
  text: "Option B supports the required retention controls.",
  sources: [{ artifact_id: report.id }],
  idempotency_key: runId,
});
```

This is a target interface, not an already-published package.
Provide complete runnable examples once the implementation exists: read a meeting, cite a source, append research, handle a conflict, consume changes, request an authorized action, revoke an agent.

Mount `/mcp` using the official TypeScript SDK Streamable HTTP transport, integrated with the Node server lifecycle and shared Effect services.
Keep dedicated tools for list_meetings, get_context, search_context, get_source, get_context_changes, add_context, revise_context, request_action, get_action, search_integration_actions, and get_integration_action.
Expose source/context resources as an optional convenience; tool access remains sufficient for clients without resource support.
Return structured content with bounded text summaries, source IDs, revisions, and tool error flags.
Declare tool annotations accurately; annotations are not authorization controls.

Pin the stable SDK and record its actually supported protocol versions in a contract test; the current baseline is SDK v1 with 2025-11-25 Streamable HTTP.
The 2026-07-28 protocol work and SDK v2 are a separate compatibility upgrade, not an implicit requirement to install prereleases.
Do not confuse legacy HTTP+SSE with Streamable HTTP responses that can themselves use SSE.
Use SDK transport behavior rather than hand-writing protocol negotiation.
Test connection, OAuth, discovery, schemas, actual tool execution, cancellation, and two concurrent principals.
An MCP protocol session is never a meeting, workspace, or identity boundary.

## 14. Fullscreen UI implementation

Recreate the visual contract in `docs/DESIGN.md` independently; the one exception, on explicit request, is the waveform and its side live updates (transcript rail and agent-work feed), ported from the earlier kiosk.
The SVG/HTML files in `design/` are newly authored visual references, not application source or copied legacy components.
The original approved appearance is a near-black full-viewport stage with a thin irregular blue-white waveform across the center.
Preserve its sparse header, small status copy, subtle glow, quiet footer controls, and large empty areas.
Do not replace it with a sidebar dashboard, rounded equalizer bars, card grid, large title, or speaking orb; the quiet transcript and agent-work rails beside the status are part of the contract.

The Canvas 2D renderer draws irregular needle peaks, an asymmetric lower contour, small broad bases, and smooth attack/decay.
Feed it real microphone levels; keep animation time independent from transcript/model latency.
Suspend visual animation when hidden and respect reduced-motion preference without stopping capture.
The preview waveform is illustrative; production must never simulate input or show fake healthy recording status.

Keep capture lifecycle outside overlay mount/unmount.
Review, Agents, and Settings are secondary dialogs, with accessible focus handling and Escape-to-close.
The main screen contains pause/resume, review, agents, settings, and fullscreen controls only.
No automatic sound effects, greetings, completion notices, or sign-offs.
Every TTS response requires a direct-request speech gate; explicit recording playback remains available.

Review contains Notes, Transcript, Recording, Memory, Context, and Activity.
Source timestamps connect notes to transcript and authorized playback.
Expose speaker correction, meeting split/merge, and memory revisions without deleting evidence.
Agents exposes connection scopes and revocation; Settings exposes sign-in, workspace/timezone, microphone, integrations, and retention.
Test real denied, paused, interrupted, uploading, saved, and degraded states.

## 15. Proposed new project layout

No application directories exist in this handoff repository yet.
Create these during implementation; do not obtain them by copying the previous repository.

| New area | Responsibility |
| --- | --- |
| `server/src/main.ts`, `server/src/api.ts` | Node lifecycle, Effect HttpApi, shared contract and web assets. |
| `server/src/db.ts`, `server/migrations/` | MySQL pool, transactions and explicit versioned migrations. |
| `server/src/auth.ts`, `server/src/agents.ts` | Identity, membership, scopes and revocation. |
| `server/src/listeners.ts`, `server/src/meetings.ts`, `server/src/boundaries.ts` | Leases, source ranges and meeting corrections. |
| `server/src/transcripts.ts`, `server/src/recordings.ts`, `server/src/speakers.ts` | Evidence, R2 manifests/playback and attribution. |
| `server/src/context.ts`, `server/src/matcher.ts` | Time-aware context, retrieval and semantic matching. |
| `server/src/jobs.ts`, `server/src/worker.ts` | Durable processing, leases, retries and completion. |
| `server/src/planner.ts`, `server/src/executor.ts`, `server/src/actions.ts` | Research, grants, action execution and receipts. |
| `server/src/config.ts`, `server/src/providers/` | Explicit model roles and concrete provider clients, including one Pipedream client. |
| `server/src/media/` | WebSocket ingest, PCM framing, source timing, turn detection and speech gate. |
| `server/src/mcp.ts`, `packages/contracts/src/` | MCP adapter and shared wire schemas/OpenAPI. |
| `web-app/src/pages/listen/`, `web-app/src/lib/capture/` | Fullscreen UI, microphone, IndexedDB recovery and uploader. |
| `sdk/typescript/`, `sdk/python/` | Thin clients and runnable examples from the same API contract. |
| `server/tests/`, `scripts/`, deployment files | Behavior fixtures, launch/check commands, containers and routing. |

Extend the existing npm manifest and lockfile with workspaces for `server`, `web-app`, `packages/contracts` and `sdk/typescript` as they are implemented.
Keep a single npm lockfile; do not introduce a competing package manager.
Compile server TypeScript to JavaScript for the production image; documentation scripts use Node's native type stripping plus separate type checking.
Keep boundaries concrete; avoid generic agent frameworks or one-interface-per-file scaffolding.

## 16. New schema, deployment, and recovery

Create fresh MySQL/InnoDB schemas through explicit versioned migrations.
No historical database import is required for this clean build.
Test empty-database setup, repeated migration invocation, partial DDL completion, constraints, and recovery.
MySQL DDL can implicitly commit; use a version ledger, execution lock, and restart-safe steps.
Do not apply schema DDL independently on every API worker startup.

Use only synthetic fixtures in the repository.
If legacy records are later requested, treat that as a separate authorized importer with ownership mapping, type conversion, row/hash validation, and a cutover plan.
The old PostgreSQL/Neon database and all external systems remain untouched by this handoff.

Stage one workspace and an open browser listener first.
Verify microphone permission, recording completeness, timestamp alignment, silent operation, isolation, matching, SDK/MCP, and external-action receipts.
Production activation requires deployment configuration and explicit authorization; creating this repository does not authorize it.

Rollback restores a previously validated application version compatible with the current schema and stops new dispatch when necessary.
Preserve data and R2 objects; do not reverse-drop tables as a rollback technique.
Reconcile running/unknown actions before another worker resumes them.
Avoid forced page reloads during capture; checkpoint available browser data and show any unavoidable gap.

## 17. Configuration and local commands

Configuration groups:

| Group | Required values |
| --- | --- |
| Core | MYSQL_HOST, MYSQL_PORT, MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD, TLS configuration, public app URL, workspace timezone, environment, API/web ports (7102/3102 in this worktree; live ingest shares the API port). |
| Identity | Issuer/client metadata, resource audiences, callback URLs, session/credential secret references, MCP authorization-server configuration and resource metadata. |
| Audio | Selected microphone, browser buffer quota/cap, archive format, source-clock metadata, stream rotation policy. |
| R2 | Account endpoint, bucket, scoped access credentials, private-object prefix; secrets server-side only. |
| Models | Explicit provider/model for voice, extraction, planner, research; provider keys; request budgets. |
| Speaker | Diarization provider/version, optional pyannote key, enrollment policy. |
| Pipedream | Project/environment/client credentials; principal/account mappings. |
| Operations | Job concurrency, request limits, recording policy, metrics/log redaction, feature rollout scope. |

Current documentation commands are `npm ci`, `npm run check`, `npm run docs:render` and `npm run docs:build`.
The application commands below are implementation deliverables; they do not exist yet.
Keep documentation and application checks named separately so a green handoff check cannot be reported as a tested recorder.
Use separate terminals/processes managed by the launcher, not a blocking shell sleep loop.
Before serving, verify the assigned ports are unused.

```bash
npm run dev -- --api-port 7102 --web-port 3102
npm run check:app
npm run build --workspace server
npm run build --workspace web-app
npm run build --workspace sdk/typescript
npm run test --workspace server
npm run test --workspace web-app
npm run test --workspace sdk/typescript
python3 -m unittest discover -s sdk/python/tests -p 'test_*.py'
node scripts/check-contracts.ts
node scripts/replay-capture.ts --fixture server/tests/fixtures/day.json --accelerated
```

Use a disposable test database for automatic migrations during tests.
Production migration execution remains a separate explicit action.
Run `npm run quality:fallow -- --base HEAD` and `npm run quality:sentrux` after staging new files.
Fallow, Sentrux and Conventional Commit checks are configured in CI; preserve their baselines and rules.
Use Conventional Commit headers and PR titles with a 72-character limit.
CI/CD is authorized and already publishes documentation.
Extend CI with real TypeScript application checks as each slice exists; run Python only in the dedicated Python SDK check once that client exists.
Production application deployment still requires its own target and authorization.
Use no-mistakes only when its branch/commit/push/PR workflow is authorized; run it in the background and monitor its status.
Do not add agent co-author attribution to commits.

## 18. Verification and completion evidence

| Area | Required check |
| --- | --- |
| Silence | Feed ordinary speech, background research, action success/failure, auto close, reconnect, and UI transitions; emitted assistant audio/SFX count stays zero. A requested answer is the positive control. |
| Capture | Open/close Review without stopping capture. Close/reload the tab, discard it, revoke permissions, and unplug the microphone; the source gap/state must be truthful. |
| Durability | Crash between IndexedDB commit, R2 write, DB manifest, and buffer cleanup; no R2-acknowledged source range disappears. Repeated chunk/hash is idempotent; conflicting hash rejects. |
| Offline | Replay network loss and provider outage; local recording remains bounded, uploads recover, transcript replay dedupes. |
| Meetings | Back-to-back meetings, long pauses, topic changes, explicit close, uncertain boundary, split and merge preserve source coverage and do not replay actions. |
| Dual-device | Room and laptop in one approved group hand off through lease/fencing; separate groups never merge. Concurrent old owner is rejected. |
| Time | Midnight, DST transition, timezone change, delayed upload, skewed clock, and "tomorrow/next Friday" remain tied to the correct event time or explicit ambiguity. |
| Speakers | Unknown and enrolled speakers, interruptions, overlap, similar voices, speaker echo, reconnect, and provider rotation; false identity is measured separately from ASR errors. |
| MySQL schema | Empty setup, version ledger, partial DDL recovery, constraints, UTC/JSON/Unicode round trips, semantic ranking, and worker locking. |
| Isolation | Two teams with colliding names/IDs exercise REST, MCP, search, caches, jobs, playback, exports, and Pipedream account selection without data crossover. |
| Agent writes | Two clients read the same revision; both submit updates; stale write gets 409, provenance persists, idempotent retry does not duplicate data. |
| Actions | Expired/revoked/mismatched grants block execution. Ambiguous timeouts become unknown. Matching receipts prevent duplicate sends/bookings. |
| UI | Fullscreen waveform matches the accepted design; no permanent dashboard. Test keyboard/focus, small laptop, reduced motion, reconnect, upload backlog, errors, and source-linked playback. |
| Performance | Matched Rust/TypeScript workload reports, declared hardware/budgets, CPU/RSS and tail latency, saturation/recovery, no loss of correctness; parity is unverified without evidence. |
| Effect lifecycle | Cancel provider calls, interrupt sockets, exhaust pools, crash workers and use a test clock for leases/retries; no leaked fibers, sockets or connections, and accepted jobs remain recoverable. |
| SDK/MCP | Run both SDK examples and real MCP discovery/read/write/conflict/revoke flows with separate principals. Schemas and errors match the shared API. |
| Compatibility | Notes, exports, matching, meeting links, and requested speech remain available under the new access model. |

Use synthetic fixtures for deterministic tests and approved real meeting recordings for model comparison.
No real email, calendar event, or other external side effect may be sent by a replay test.
Test an accelerated 24-hour capture trace plus a real staging soak; accelerated replay does not prove 24 hours of wall-clock uptime.
Require a 24-hour staging soak before describing the system as live-verified for 24/7 operation.
If execution time or credentials prevent that soak, deliver implemented/local-tested status with the specific remaining live gate.

Completion report must state separately: implemented, locally tested, model-evaluated, web-built, migrated, deployed, and live-verified.
Attach logs/results for the checks actually run and list all unrun gates with reasons.
A build passing is not evidence of microphone permissions, model quality, real integration delivery, or production uptime.

## 19. Ordered delivery and one-shot execution

Use the task checklist in `tasks/todo.md` as the execution order.
One-shot means one cohesive implementation effort with internal checkpoints and one final handoff, not one enormous untested patch.
Resolve failures and ordinary implementation details autonomously within the approved scope.
Each checkpoint leaves a runnable vertical slice; do not expose incomplete capture/action behavior behind optimistic success labels.

Start with ownership/auth and the capture durability path, then meetings/context, then actions/agent access, then the preserved UI and web delivery.
The validated UI is a constraint, not an invitation to redesign it again.
Keep tests near the behavior they protect and inspect the actual app after each UI change.

## 20. Evidence and authoritative references

Repository evidence is pinned to the reference commit above; it is historical, not a source tree to import or a current runtime recommendation.
Python paths in these historical source URLs describe the reference system only.

- [Sanctum waveform implementation](https://github.com/42nights/sanctum/blob/49aef4a49fa5facc485d5858690860fd028491d7/web-app/src/pages/kiosk/engine.ts#L117)
- [Sanctum media/session lifecycle](https://github.com/42nights/sanctum/blob/49aef4a49fa5facc485d5858690860fd028491d7/realtime/server.py#L1216)
- [Sanctum historical schema](https://github.com/42nights/sanctum/blob/49aef4a49fa5facc485d5858690860fd028491d7/backend/app.py#L71)
- [Jcyber memory contract](https://github.com/i098/Jcyber/blob/29a8583b523b1965b75a3232673ee6918dff050a/schema/tencentdb/memory-interface.md)
- [Jcyber pinned SQLite backend](https://github.com/i098/Jcyber/blob/29a8583b523b1965b75a3232673ee6918dff050a/deploy/memory_core.py)
- [Browser microphone access](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [Screen Wake Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)
- [Browser storage persistence](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
- [Node.js worker threads](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)
- [Node.js performance hooks](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html)
- [Node.js event-loop guidance](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)
- [Node.js TypeScript execution](https://nodejs.org/docs/latest-v24.x/api/typescript.html)
- [Effect v3 HTTP contracts](https://effect.website/docs/v3/api/platform/HttpApi)
- [Effect MySQL adapter](https://effect.website/docs/v3/api/sql-mysql2/MysqlClient)
- [Workers AI Whisper large v3 turbo](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/)
- [OIDC client](https://github.com/panva/openid-client)
- [Pipedream component execution](https://pipedream.com/docs/connect/components)
- [MySQL 8.4 FULLTEXT](https://dev.mysql.com/doc/refman/8.4/en/fulltext-search.html)
- [MySQL JSON](https://dev.mysql.com/doc/refman/8.4/en/json.html)
- [R2 upload methods](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [R2 signed access](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Workers AI OpenAI-compatible endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)
- [Workers AI JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/) and the [Qwen 3.8 27B model schema](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/)
- [pyannote Live-1 protocol and limits](https://docs.pyannote.ai/tutorials/streaming-real-time)
- [pyannote Precision-3 release](https://www.pyannote.ai/changelog/precision-3)
- [Official TypeScript MCP SDK](https://ts.sdk.modelcontextprotocol.io/)
- [MCP baseline transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP baseline authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

All new schemas, route names, module boundaries, thresholds, and SDK examples in this plan are proposed implementation contracts.
They are not claims that the current repository already provides those capabilities.
