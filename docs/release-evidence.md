# Release evidence

Evidence for the clean build of [tasks/plan.md](../tasks/plan.md) at the delivery branch head.
Each state and acceptance row below says what was run, where the proof lives, and what remains unrun and why.
Nothing here claims real-world model quality, delivered external side effects, deployment or uptime.

## States

| State | Status | Evidence |
| --- | --- | --- |
| Implemented | Yes, with the open items below | T01–T25 on this branch; slice ownership and seams in [ARCHITECTURE.md](ARCHITECTURE.md). |
| Locally tested | Yes | `npm run check:app`: workspace typechecks, 443 Vitest tests against MySQL 8.4, 36 Playwright specs in Chromium, benchmark manifest, benchmark correctness smoke, accelerated day replay. Python SDK: 7 unittest cases in an isolated venv. `npm run check` for the handoff. Rust benchmark reference: 9 `cargo test` cases and a matched `node scripts/benchmark-compare.ts --smoke` run. |
| Model-evaluated | No (unrun) | No approved real meeting recordings or provider credentials were available; model and speaker behavior is tested only with fixture providers (`fixtureLlm`, fixture Deepgram/pyannote/Cartesia/Pipedream). |
| Web-built | Yes | `npm run build -w web-app` (Vite) inside `check:app`; the API serves the build (`server/tests/capabilities.test.ts`, deep links and security headers). |
| Migrated | Disposable databases only | Every test suite migrates a fresh MySQL 8.4 database (`server/tests/migrations.test.ts` covers fresh, repeated, concurrent, interrupted and edited runs). No production or staging migration was run: not authorized. |
| Deployed | No | No deployment target or authorization. `docker-compose.yml`, `server/Dockerfile` and `Caddyfile` exist; the compose HTTPS smoke was run only by the serve slice on its own branch. |
| Live-verified | No | No live microphone session against real providers, no staging environment and no 24-hour soak. |

## Acceptance (plan section 18)

| Area | Result | Evidence and gaps |
| --- | --- | --- |
| Silence | Pass (fixtures) | `server/tests/silence.test.ts`: ordinary speech, partial wake words, passive transitions, self-echo, barge-in, reconnect and speech-window expiry emit nothing; a direct request is the positive control. The day replay opens no speech or action work. Real room audio unrun (no approved recordings). |
| Capture | Pass | `web-app/tests/capture-lifecycle.test.ts`: denial, missing input, hardware failure, revocation, unplug, tab close, sleep gap, freeze/discard, storage full/cleared, capture stops on listener removal. `web-app/e2e/capture*.spec.ts`, `listen-capture.spec.ts`: real Chromium capture, reload recovery, overlays keep capture running. Removed-listener audio: `web-app/tests/orphans.test.ts` (per-epoch WAV export, parts over the WAV size limit, gaps on the capture clock), `capture-lifecycle.test.ts` and `web-app/e2e/orphaned-audio.spec.ts` (listed only while no tab captures, export first, discard only after confirmation and never of uploadable audio). |
| Durability | Pass | `server/tests/recording-uploads.test.ts` (receipt only after object and manifest, R2-success/manifest-failure reconciliation, ambiguous timeout via `head`, idempotent repeat, conflicting hash rejected); `web-app/tests/uploader.test.ts` and `capture-buffer.test.ts` (local cleanup only after receipt). |
| Offline | Pass | `server/tests/transcript-recovery.test.ts`, `ingest.test.ts` (provider outage degrades and recovers from the archive, backpressure skips live ASR), `recording-uploads.test.ts` (late out-of-order backlog), browser offline backlog in `capture.spec.ts`. |
| Meetings | Pass | `server/tests/meeting-boundaries.test.ts`, `boundary-corrections.test.ts` (pause vs boundary, explicit close, back-to-back, split/merge coverage, action receipts untouched); `npm run replay:capture` (4 meetings, 190 segments, each owned by exactly one meeting over a synthetic 24 hours). |
| Dual-device | Pass | `server/tests/handoff.test.ts`: one owner per group, room preference, laptop takeover after lapse, stale owner fenced after partition, no cross-group sharing. |
| Time | Pass, one gap | `server/tests/context-time.test.ts` (meeting timezone, DST skipped/repeated times unresolved, weekdays and "tomorrow"), `context-changes.test.ts` (delayed upload resolved against the utterance). A skewed client clock is not tested separately. |
| Speakers | Pass (fixtures) | `server/tests/speakers.test.ts`: unknown and enrolled speakers, overlap, similar voices, rotation/reconnect never carry labels, false identity measured separately, voice never authorizes. Real-audio comparison of Deepgram vs pyannote unrun (no approved audio or keys). |
| MySQL schema | Pass | `server/tests/migrations.test.ts`, `db.test.ts` (UTC microseconds, BIGINT, JSON, Unicode, composite ownership keys), `semantic-matching.test.ts`, `jobs.test.ts` (SKIP LOCKED claims, fencing). |
| Isolation | Pass | `server/tests/authorization.test.ts`, `capabilities.test.ts` (notes, exports, matching across workspaces), `mcp.test.ts` (tenants), `context.test.ts` (search, caches after revocation), `playback-access.test.ts`, `pipedream.test.ts` (account selection). |
| Agent writes | Pass | `server/tests/context.test.ts` (one of two same-revision writers wins with 409, idempotent retry), `api-contract.test.ts` and `mcp.test.ts` (shared revisions across SDK and MCP). |
| Actions | Pass | `server/tests/actions.test.ts`, `worker-recovery.test.ts`: expired/revoked/mismatched grants block, ambiguous timeouts become `unknown` and are never replayed, duplicate requests deduplicate, over-budget results stored as artifacts. No real external write was sent. |
| UI | Pass | `web-app/e2e/listen-visual.spec.ts` (1280×720 against the reference, narrow laptop), `listen-waveform.spec.ts` (real audio, reduced motion, hidden page, interruption), `listen-rails.spec.ts` (final transcript lines and action receipts arriving in the side rails), `listen-overlays.spec.ts` (focus and keyboard), `review-notes.spec.ts`. Review: `review-tabs.spec.ts` (all six tabs over fixture responses; per-source loading, empty, forbidden and unavailable states; decision or note source to transcript segment to a seek in the signed recording) and `review-server.spec.ts` (the same path against the real API server and a seeded MySQL database, playing the assembled cut at the saved-sample offset past a gap); `web-app/tests/review-data.test.ts` (paging, per-source failures, sample-to-playback mapping). |
| Performance | Unrun (parity) | Matched harness: the benchmark-only Rust reference (`benchmarks/rust`) and `scripts/benchmark-compare.ts`. One uncontrolled-host run of all five workloads in both implementations with source and fixture hashes: [benchmarks/README.md](../benchmarks/README.md). Fixture hashes and the MySQL end state matched, no operation failed, `pcm_ingest` saturation was swept, and a 300 s long run stayed within its RSS bound. The host is a shared, loaded VM and the reference hardware is unverified, so parity is neither claimed nor refuted; MySQL concurrency and saturation sweeps are unrun. |
| Effect lifecycle | Pass, one gap | `jobs.test.ts` and `worker-recovery.test.ts` (lease loss interrupts handlers, killed workers recover, accepted work survives the API), `api-contract.test.ts` and `mcp.test.ts` (client abort cancels the server handler), `ingest.test.ts` (sockets). Pool exhaustion is not tested separately. |
| SDK/MCP | Pass | `sdk/typescript/tests`, `sdk/python/tests` (both examples end to end against the fixture server), `server/tests/mcp.test.ts` (eleven tools, discovery, schema equality with REST, conflict, revoke, separate principals). |
| Compatibility | Pass, one gap | Notes, exports, matching and meeting deep links: `server/tests/capabilities.test.ts`, `notes.test.ts`, `matching.test.ts`. Requested speech works for a principal with context access (`silence.test.ts`); a room device credential lacks `context:read`, so a request spoken at a device gets no reply yet. |

## Unrun gates

| Gate | Reason |
| --- | --- |
| Approved model/audio comparison | Needs approved real meeting recordings and provider credentials; neither is in scope. |
| 24-hour staging soak | Needs a staging environment and 24 hours of wall-clock time; the accelerated replay covers one synthetic day of source time only. |
| Rust/TypeScript parity | Needs a controlled benchmark host named in the manifest (T01); the matched harness and one uncontrolled-host run exist, and the steps a controlled run must take are in [benchmarks/README.md](../benchmarks/README.md). |
| Production migration, deployment, package publication, recording activation | Each needs its own authorization (plan section 16, [DECISIONS.md](DECISIONS.md)). |
| Sign-in issuer, MCP authorization server, retention, outside-meeting speech | Open decisions; production activation refuses to start until they are selected. |

## Open implementation items

- Automatically detected meetings start `restricted` with no grants, so members cannot see them until access is granted; ownership assignment waits on the sign-in and outside-meeting decisions.
- Spoken replies from a room device need a reply authority (for example the listener's human owner).
- `research.run` needs a meeting and plans only over actions already inspected.

## Checklist items left open

| Item | Why it stays unticked |
| --- | --- |
| T01: named reference hardware and CPU/RAM limits | The manifest and result format exist, but no controlled benchmark host is named; the fields stay `null` and `unverified`. |
| T26: approved model/audio comparison and 24-hour soak | Unrun; see Unrun gates. |
| T26: matched Rust/TypeScript harness | The harness, the Rust reference and one uncontrolled-host run with source and fixture hashes are published, including `pcm_ingest` saturation and a 300 s memory bound. Parity gates, reference-hardware budgets and MySQL concurrency sweeps need a controlled host and concurrent drivers. |
