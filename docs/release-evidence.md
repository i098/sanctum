# Release evidence

Evidence for the clean build of [tasks/plan.md](../tasks/plan.md) at the delivery branch head.
Each state and acceptance row below says what was run, where the proof lives, and what remains unrun and why.
Nothing here claims delivered external side effects or uptime; the one deployment is described under Deployed.
The only model-quality evidence is the small Workers AI smoke comparison under Workers AI text models; it is not a quality benchmark.

## States

| State | Status | Evidence |
| --- | --- | --- |
| Implemented | Yes, with the open items below | T01–T25 on this branch; slice ownership and seams in [ARCHITECTURE.md](ARCHITECTURE.md). |
| Locally tested | Yes | This slice passed `npm run check:app`: workspace typechecks, 681 Vitest tests against MySQL, 98 Playwright checks, web builds, benchmark smoke and accelerated day replay. `npm run check`, docs render/build, Fallow and Sentrux also passed. Earlier delivery evidence includes seven Python SDK checks and the Rust benchmark reference. |
| Model-evaluated | Partial (smoke only) | Speaker behavior and real-meeting speech-to-text remain fixture-only; no approved real meeting recordings were available. Live Whisper chunk lengths were measured on synthetic speech ([DECISIONS.md](DECISIONS.md#speech-to-text-decision--2026-10-08)). Workers AI text roles had a synthetic smoke comparison. Aura-2 had one live byte check; see Workers AI speech output. |
| Web-built | Yes | `npm run build -w web-app` (Vite) inside `check:app`; the API serves the build (`server/tests/capabilities.test.ts`, deep links and security headers). |
| Migrated | Disposable databases and the Cloudflare deployment's database | Every test suite migrates a fresh MySQL 8.4 database (`server/tests/migrations.test.ts` covers fresh, repeated, concurrent, interrupted and edited runs). The `sanctum` database on the Aiven MySQL 8.4 service (`sql_require_primary_key=1`) was migrated with the image's `node server/dist/migrate.js` over verified TLS; every migration applied unchanged. |
| Deployed | Yes, development mode | Cloudflare, 42nights account ([operations.md](operations.md#cloudflare)): Worker `sanctum` at `https://app.sanctum.42nights.dev` (custom domain; the apex `https://sanctum.42nights.dev` answers 308 to it), Container applications `sanctum-sanctumapi` and `sanctum-sanctumjobs`, R2 bucket `sanctum-recordings`, `SANCTUM_ENV=development` with no provider keys. The deployed commit is recorded on the pull request that added the deployment. |
| Live-verified | Deployment only | Through the Worker, recorded before the app moved from the apex to `app.sanctum.42nights.dev`: the website loads, `/healthz` is ok and `/readyz` is ready (MySQL reachable over TLS, schema current), `/api/v1/meetings` answers 200 with the owner session and 401 without it, Listen in Chromium with a fake microphone upgrades the listener WebSocket and uploads 30-second chunks to the private bucket, a presigned GET for an uploaded chunk returns the WAV (unsigned is refused), and the job worker keeps polling MySQL while the API container sleeps. No live microphone session against real providers, no meeting playback through Review (detected meetings start restricted), no staging environment and no 24-hour soak. |

## Acceptance (plan section 18)

| Area | Result | Evidence and gaps |
| --- | --- | --- |
| Silence | Pass (fixtures) | `server/tests/silence.test.ts`: ordinary speech, partial wake words, passive transitions, self-echo, barge-in, reconnect and speech-window expiry emit nothing; a direct request is the positive control. The day replay opens no speech or action work. Real room audio unrun (no approved recordings). |
| Capture | Pass | `web-app/tests/capture-lifecycle.test.ts`: denial, missing input, hardware failure, revocation, unplug, tab close, sleep gap, freeze/discard, storage full/cleared, capture stops on listener removal, a silent input (exact digital zero) warns after the threshold and a quiet room never does, a chosen input moves the running epoch and persists, a gone input falls back to the default. `web-app/e2e/capture*.spec.ts`, `listen-capture.spec.ts`: real Chromium capture, reload recovery, overlays keep capture running. `listen-microphone.spec.ts`: on fake inputs with the real engine, the silent-input warning names the input and clears on sound, the picker moves capture and the choice persists, Settings checks an input before listening. Removed-listener audio: `web-app/tests/orphans.test.ts` (per-epoch WAV export, parts over the WAV size limit, gaps on the capture clock), `capture-lifecycle.test.ts` and `web-app/e2e/orphaned-audio.spec.ts` (listed only while no tab captures, export first, discard only after confirmation and never of uploadable audio). |
| Durability | Pass | `server/tests/recording-uploads.test.ts` (receipt only after object and manifest, R2-success/manifest-failure reconciliation, ambiguous timeout via `head`, idempotent repeat, conflicting hash rejected); `web-app/tests/uploader.test.ts` and `capture-buffer.test.ts` (local cleanup only after receipt). |
| Offline | Pass | `server/tests/transcript-recovery.test.ts`, `ingest.test.ts` (provider outage degrades and recovers from the archive, backpressure skips live ASR and the next lane's first answer reports `recovered`; 150 s of 44.1 kHz speech at measured Workers AI latency, one 12.6 s and one missing answer, stays live; a provider too slow for live reports `asr_backlog` and the closed meeting completes from batch), `recording-uploads.test.ts` (late out-of-order backlog), browser offline backlog in `capture.spec.ts`; the page clears "behind" on `recovered` in `web-app/e2e/listen-capture.spec.ts`. |
| Meetings | Pass | `server/tests/meeting-boundaries.test.ts`, `boundary-corrections.test.ts` (pause vs boundary, explicit close, End fences the audio before the pause (late finals join the closed meeting and finalize it again, an API close stays open to speech), idle close after 10 minutes without speech, back-to-back, split/merge coverage, action receipts untouched); End before the pause reaches the server in `ingest.test.ts`, `migrations.test.ts`; End meeting in `web-app/e2e/listen-capture.spec.ts`; `npm run replay:capture` (4 meetings, 190 segments, each owned by exactly one meeting over a synthetic 24 hours). |
| Dual-device | Pass | `server/tests/handoff.test.ts`: one owner per group, room preference, laptop takeover after lapse, stale owner fenced after partition, no cross-group sharing. |
| Time | Pass, one gap | `server/tests/context-time.test.ts` (meeting timezone, DST skipped/repeated times unresolved, weekdays and "tomorrow"), `context-changes.test.ts` (delayed upload resolved against the utterance). A skewed client clock is not tested separately. |
| Speakers | Pass (fixtures) | `server/tests/speakers.test.ts`: unknown and enrolled speakers, overlap, similar voices, rotation/reconnect never carry labels, false identity measured separately, voice never authorizes. Whisper returns no speaker labels; real-audio pyannote evaluation unrun (no approved audio or keys). |
| MySQL schema | Pass | `server/tests/migrations.test.ts`, `db.test.ts` (UTC microseconds, BIGINT, JSON, Unicode, composite ownership keys), `semantic-matching.test.ts`, `jobs.test.ts` (SKIP LOCKED claims, fencing). |
| Isolation | Pass | `server/tests/authorization.test.ts`, `capabilities.test.ts` (notes, exports, matching across workspaces), `mcp.test.ts` (tenants), `context.test.ts` (search, caches after revocation), `playback-access.test.ts`, `pipedream.test.ts` (account selection). |
| Agent writes | Pass | `server/tests/context.test.ts` (one of two same-revision writers wins with 409, idempotent retry), `api-contract.test.ts` and `mcp.test.ts` (shared revisions across SDK and MCP). |
| Actions | Pass | `server/tests/actions.test.ts`, `worker-recovery.test.ts`: expired/revoked/mismatched grants block, ambiguous timeouts become `unknown` and are never replayed, duplicate requests deduplicate, over-budget results stored as artifacts. `server/tests/research.test.ts`: `research.run` offers only inspected, granted actions and submits them through the gateway, a retried job never resubmits an `unknown` write, a retried job that stored its research does not pay for it again, a retried job whose earlier attempt requested an action reports that action and plans nothing again whatever the planner answers, web research returns cited sources and records usage, a spent per-workspace or install-wide daily allowance refuses the next paid call, an email planned with research is filled from the cited research and carries its fact and source, a research page that asks for another recipient changes no recipient and adds no action, refused research requests no action, a requester who lost write access to the meeting gets no research, a dropped proposal is reported with its reason, and nothing to do is a reported outcome; `llm.test.ts`: an incomplete paid research answer still records its usage; `planner.test.ts`: two research-pass emails to one recipient keep distinct keys. No real external write was sent. |
| UI | Pass | `web-app/e2e/listen-visual.spec.ts` (1280×720 against the reference, narrow laptop), `listen-waveform.spec.ts` (real audio, reduced motion, hidden page, interruption), `listen-rails.spec.ts` (final transcript lines and action receipts arriving in the side rails), `listen-overlays.spec.ts` (focus and keyboard), `review-notes.spec.ts`. Review: `review-tabs.spec.ts` (all six tabs over fixture responses; per-source loading, empty, forbidden and unavailable states; decision or note source to transcript segment to a seek in the signed recording) and `review-server.spec.ts` (the same path against the real API server and a seeded MySQL database over a real browser session, so the recording-access POST needs the CSRF header, playing the assembled cut at the saved-sample offset past a gap); `web-app/tests/review-data.test.ts` (paging, per-source failures, sample-to-playback mapping). First-run welcome: `listen-welcome.spec.ts` (opens for a new signed-in person; Skip and Start listening store it as done and it stays closed after a reload; Settings opens it again; every step by keyboard with focus on each step's heading; rename for owners and admins, none for members; hosted Invite teammates and Set up team; the level meter moves with Chromium's fake microphone), `team-csp.spec.ts` (Skip against the real server with the CSRF header) and `server/tests/onboarding.test.ts` (completion per principal, idempotent; rename only with `workspace:admin`, trimmed, 1–200 characters). |
| Performance | Unrun (parity) | Matched harness: the benchmark-only Rust reference (`benchmarks/rust`) and `scripts/benchmark-compare.ts`. One uncontrolled-host run of all five workloads in both implementations with source and fixture hashes: [benchmarks/README.md](../benchmarks/README.md). Fixture hashes and the MySQL end state matched, no operation failed, `pcm_ingest` saturation was swept, and a 300 s long run stayed within its RSS bound. The host is a shared, loaded VM and the reference hardware is unverified, so parity is neither claimed nor refuted; MySQL concurrency and saturation sweeps are unrun. |
| Effect lifecycle | Pass, one gap | `jobs.test.ts` and `worker-recovery.test.ts` (lease loss interrupts handlers, killed workers recover, accepted work survives the API), `api-contract.test.ts` and `mcp.test.ts` (client abort cancels the server handler), `ingest.test.ts` (sockets). Pool exhaustion is not tested separately. |
| SDK/MCP | Pass | `sdk/typescript/tests`, `sdk/python/tests` (both examples end to end against the fixture server), `server/tests/mcp.test.ts` (eleven tools, discovery, schema equality with REST, conflict, revoke, separate principals). |
| Compatibility | Pass, one gap | Notes, exports, matching and meeting deep links: `server/tests/capabilities.test.ts`, `notes.test.ts`, `matching.test.ts`. Requested speech works for a principal with context access (`silence.test.ts`); a room device credential lacks `context:read`, so a request spoken at a device gets no reply yet. |

## Workers AI speech output

One live REST call on 2026-10-10 used `@cf/deepgram/aura-2-en` and the existing server-only Workers AI token.
The request used synthetic text: "Sanctum speaks only when you ask."
Controls: `speaker: luna`, `encoding: linear16`, `container: none`, `sample_rate: 24000`.
HTTP 200 returned 119,040 bytes with an `audio/mpeg` header.
The bytes contain raw mono PCM16 little-endian, 59,520 samples at 24 kHz, lasting 2.48 seconds.
The prefix is `eaffeeffedffe4ffe1ffeafffcff2500`; no RIFF, ID3, Ogg or FLAC header appears.
A forced MPEG decode with FFmpeg returned exit 69, zero decoded bytes, and `Header missing`.
Adjacent PCM samples have correlation 0.971; peak amplitude is 11,431 and RMS is 1,529.
Raw payload SHA-256: `0496c263ef0fa12171440b8095927f46a59152d70cf40e8a83e766a512699a69`.
FFprobe reported `pcm_s16le`, 24,000 Hz, one channel and 2.480000 seconds for a temporary WAV.
The repository retains only the text evidence, not the audio sample.

A temporary Playwright scenario passed these bytes through the actual Aura adapter and Chromium's `OfflineAudioContext`.
Browser output matched all 59,520 PCM samples exactly.
Cancellation stopped playback and rejected late chunks; the cancelled render contained only zero samples.
The temporary scenario was removed after it passed.
`speech-provider.test.ts`, `silence.test.ts` and `playback.test.ts` passed 24 checks, including request aborts before headers and during audio.
The adapter preserves sample boundaries across odd-sized HTTP chunks and reports truncated samples as unavailable.
The existing gate checks sentence order, expiry, barge-in, stale generations, reconnect and silent background work.
This check proves the byte format and local playback path, not voice quality, production latency or a deployment.

## Workers AI text models

Smoke comparison on 2026-10-08, separate from the Vitest suites, which only use canned `fixtureLlm` and local replay servers.
Endpoint: Workers AI OpenAI-compatible `POST /client/v4/accounts/<account>/ai/v1/chat/completions` on the 42nights account.
Calls went through `server/src/providers/workers-ai.ts` and the real `extractCandidates`, `summarizeMeeting` and `respondToRequest` code, one attempt per call.
A throwaway script ran it; the script is not committed and the token is not recorded.
Fixtures: the synthetic meeting, transcript and context snapshot of `server/tests/extraction.test.ts` (final segments S1–S4 and one partial line, America/Los_Angeles, on the 2026-11-01 DST day) and the `respondToRequest` context of `server/tests/planner.test.ts` (one committed and one superseded decision; request "Who gets pilot access?").

| Model | Extraction | Notes | Voice | Calls |
| --- | --- | --- | --- | --- |
| `@cf/qwen/qwen3.8-27b` | 4 | 4 (2 before the notes prompt change, 2 after) | 2 | 10 |
| `@cf/openai/gpt-oss-120b` | 2 | 3 (1 before, 2 after) | 1 | 6 |
| `@cf/zai-org/glm-4.7-flash` | 2 | 1 (before) | 1 | 4 |
| `@cf/google/gemma-4-26b-a4b-it` | 2 | 1 (before) | 1 | 4 |

Total: 24 calls.

- Extraction (4 labeled core facts per run: S1 decision, S2 commitment, S3 decision, S4 open question):
  - qwen found 14 of 16 over 4 runs; both misses labeled S3 a commitment instead of a decision. It kept exactly 4 candidates per run, resolved "tomorrow at 10" to 2026-11-01T18:00Z and "by Monday" to 2026-11-02T08:00Z in every run, and never repeated the existing MySQL decision.
  - gpt-oss found 8 of 8.
  - glm found 7 of 8: grounding dropped one candidate whose time phrase was not in the cited line, and one run left "by Monday" unresolved.
  - gemma found 7 of 8 and took 50–56 s per call.
- Notes:
  - Before the notes prompt change, models put point text instead of S-refs in segments, so grounding dropped every point (qwen 2 runs, gpt-oss 1 run). glm returned markdown that failed the `meeting_notes` schema. gemma timed out at 60 s.
  - After the `NOTES_SYSTEM` change in `server/src/extraction.ts`, qwen (2 runs) and gpt-oss (2 runs) kept 4 of 4 points citing all 4 final segments, and never mentioned the partial "cancel" line.
- Voice:
  - No model mentioned the superseded "open to everyone" decision.
  - qwen answered "Pilot access stays with the test group." both times; first text came after 2.5 s and 7.7 s.
  - gpt-oss answered "The pilot access stays with the test group. No other groups receive it."; the second sentence is not in the context.
  - glm was correct; first text came after 13 s.
  - gemma answered "The test group gets pilot access." after 4 s.
- Limits: one small synthetic fixture and 1–4 runs per model, with no repeated-trial statistics. This is a smoke-level comparison, not a quality benchmark. Real meeting audio and transcripts, repeated trials and the planner role were not evaluated.

## Workers AI planner - 2026-10-10

The spoken-work tests use the production `LlmLive` and Workers AI adapter with fake HTTP responses and isolated MySQL databases.
The earlier implementation recorded 22 passing spoken-work cases; this review did not rerun them.
Before the fix, the accepted-request case failed: Workers AI credentials without an Anthropic key produced zero jobs.
A standalone service smoke used a local HTTP server and disposable MySQL database.
It confirmed one job after duplicate acceptance, no jobs for answer-only, revoked or malformed requests, and preservation of the request and owner.
Existing proposal tests validate inspected-action selection, argument checks and idempotency through the shared schema decoder.
No live planner evaluation, research execution, deployment or real integration write ran for this slice.
The two added Anthropic spoken-work regression cases remain unrun because the MySQL test server was unavailable.
The earlier ponytail review named no cuts and said "Looks good. Ship.", but its wrapper returned exit 2.
That result is not a clean ponytail exit.
This review round passed 24 focused LLM and planner tests.
A standalone `LlmLive` smoke passed with both the Anthropic planner default and an explicit model.
The spoken-work job tests could not run: Docker first denied access, then the MySQL container's published port refused connections.
The server TypeScript check passed.

## Unrun gates

| Gate | Reason |
| --- | --- |
| Approved model/audio comparison | Needs approved real meeting recordings and provider credentials; neither is in scope. |
| 24-hour staging soak | Needs a staging environment and 24 hours of wall-clock time; the accelerated replay covers one synthetic day of source time only. |
| Rust/TypeScript parity | Needs a controlled benchmark host named in the manifest (T01); the matched harness and one uncontrolled-host run exist, and the steps a controlled run must take are in [benchmarks/README.md](../benchmarks/README.md). |
| Production activation, package publication, recording activation | Each needs its own authorization (plan section 16, [DECISIONS.md](DECISIONS.md)); the Cloudflare deployment runs in development mode. |
| Sign-in issuer, MCP authorization server | Decided ([DECISIONS.md](DECISIONS.md), 2026-10-08). Hosted is configured for WorkOS AuthKit ([operations.md](operations.md#cloudflare)); the isolated-browser sign-in run is not recorded yet. The self-hosted embedded Better Auth issuer exists ([operations.md](operations.md#self-hosted-sign-in)) but runs in no deployment. Local runs did not exercise a Client ID Metadata Document authorization or MCP acceptance of an issuer-signed access token. Self-hosted team management (Better Auth organizations, migration 013) is covered by its MySQL API tests (invite, accept, role change, removal) and by Chromium specs that fake the `/idp` routes (Team opens over Settings, a person outside the team, the phone layout); it runs in no deployment either. A browser run of invite, accept, role change and removal against the real embedded issuer has not been run. |
| WorkOS organization sync, self-serve workspaces, Team widgets | Tested only against a WorkOS fake at the fetch boundary (the Team widgets against faked WorkOS API answers in Chromium, on the built site under the real CSP); no live WorkOS call has run. Live use needs the `WORKOS_API_KEY` secret, the `owner` environment role and the site's allowed web origin in the WorkOS dashboard ([operations.md](operations.md#workos-organizations)). |
| OpenAI web research | Tested only against an OpenAI fake at the fetch boundary; no live Responses call has run and no actual usage is recorded, so the monthly estimate in [DECISIONS.md](DECISIONS.md#web-research-provider-decision---2026-10-10) is unconfirmed. Live use needs the `OPENAI_API_KEY` Worker secret. |
| Retention, outside-meeting speech | Open decisions; production activation refuses to start until they are selected. |

## Open implementation items

- Spoken replies from a room device need a reply authority (for example the listener's human owner).
- See the [actions architecture](ARCHITECTURE.md#actions-t18-t19-recovery-t20) for the authorized spoken-work handler and ASR timing limits.

## Checklist items left open

| Item | Why it stays unticked |
| --- | --- |
| T01: named reference hardware and CPU/RAM limits | The manifest and result format exist, but no controlled benchmark host is named; the fields stay `null` and `unverified`. |
| T26: approved model/audio comparison and 24-hour soak | Unrun; see Unrun gates. |
| T26: matched Rust/TypeScript harness | The harness, the Rust reference and one uncontrolled-host run with source and fixture hashes are published, including `pcm_ingest` saturation and a 300 s memory bound. Parity gates, reference-hardware budgets and MySQL concurrency sweeps need a controlled host and concurrent drivers. |
