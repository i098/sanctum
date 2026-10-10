# Decisions

## Confirmed

- Use TypeScript + stable Effect v3 on Node.js for all application services and repository tooling; retain a thin Python client SDK.
- Use one Node application image with API and worker entrypoints, browser WebSocket PCM ingest, MySQL-backed durable jobs, and the official TypeScript MCP SDK.
- Target workload-specific Rust performance with optimized TypeScript; require matched benchmarks and report gaps without changing application language silently.
- Build a fresh application; include no legacy application code.
- Start with a website using microphone access on room computers and laptops.
- No Electron/native application or mandatory system-audio capture.
- Preserve the fullscreen, listening-first waveform appearance almost 1:1.
- Human UI use is occasional; agents do most context reading and writing.
- Keep silent unless directly requested; allow research and previously authorized actions in the background.
- Detect meeting boundaries automatically and provide manual split/merge.
- Keep full meeting transcripts and private R2 recordings; memory selection is separate.
- Use MySQL 8.4 LTS/InnoDB, not Postgres, for structured data.
- Keep Pipedream's catalog server-side, with search/inspect/request gateways.
- Expose one shared context model through website, SDKs, and MCP.
- Limit seats (owner, admin, member; agents and devices are free) per workspace in Sanctum before self-serve opens: the hosted site sets `SANCTUM_DEFAULT_SEAT_LIMIT=5` (`deploy/cloudflare/wrangler.jsonc`), a small-team pilot that caps per-workspace recording and model cost; `workspaces.seat_limit` overrides it. With the variable unset, the server applies no limit, so self-hosted installs are unlimited unless the operator sets one.

## Spoken work decision - 2026-10-10

The captain chose model judgment: "The model should be start enough to decide whether or not to do something (recommended)".
Accepted: after a completed direct spoken request during a live meeting, the classifier model decides whether Sanctum should do background work.
It returns only a boolean; keyword rules do not make this decision.
Accepted work retains the original spoken request without model rewriting.
A work request enqueues one durable `research.run` for the listener's current meeting, on behalf of the listener owner.
The listener, capture epoch and request ID identify the work, so duplicate finals and retries cannot start another run.
Final segments collected within a turn are deduplicated by ID and ordered by source samples before either model receives the request.
The listener lock precedes transaction reads of current authorization, grants, and all job history.
Answer-only requests still use the existing spoken reply path and start no research.
Missing planner credentials, missing Pipedream configuration, or no current meeting prevents enqueue and logs the reason.
Before classification and enqueue, the listener owner must hold at least one active integration grant in the workspace.
Expired or revoked grants and disconnected accounts do not qualify; no qualifying grant logs the reason and starts no research.
The trigger resolves current membership and requires capture scope before classification and again before enqueue, including on an existing socket.
The existing `requestAction` gateway still requires stored grants for external actions; background completion never speaks.
The [actions architecture](ARCHITECTURE.md#actions-t18-t19-recovery-t20) records the authorized handler and ASR timing limits.

## Planner provider decision - 2026-10-10

Accepted: the planner uses Cloudflare Workers AI `@cf/qwen/qwen3.8-27b`, with low reasoning, for inspected action proposals and research synthesis.
The classifier now owns spoken-work decisions; see the [classifier decision](#spoken-classifier-provider-decision---2026-10-10).
Both roles send strict JSON schemas and validate replies with the existing Effect Schema decoder.
The [spoken work decision](#spoken-work-decision---2026-10-10) owns the trigger prerequisites.
The [configuration guide](operations.md#configuration) owns provider credentials and overrides.
If both classifier and planner return malformed decisions, Sanctum logs a warning and enqueues nothing.
This slice changes no research execution or speech synthesis behavior.
See [release evidence](release-evidence.md#workers-ai-planner---2026-10-10) for local checks and unrun planner evaluation.

## Spoken classifier provider decision - 2026-10-10

Accepted: only the spoken yes/no work decision uses Cerebras `gpt-oss-120b`, with low reasoning, through the `classifier` role.
Planning and synthesis keep Workers AI Qwen; research and its paid-call caps stay unchanged.
The server-only `CEREBRAS_API_KEY` enables strict [JSON-schema chat completions](https://inference-docs.cerebras.ai/capabilities/structured-outputs).
`CLASSIFIER_MODEL_PROVIDER` and `CLASSIFIER_MODEL` override the classifier without changing the planner.
An absent key, provider failure or invalid decision logs one fallback line and sends the same decision request to the planner.
The speech controller runs this work separately from the spoken reply.
The 2026-10-10 evaluation used Sanctum's prompts with ten work cases, five planning cases and five fixed-source synthesis cases per model.

| Model | Correct work /10 | Planning points /10 | Synthesis points /10 | All-call median s | Work median s |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cerebras GPT-OSS 120B | 10 | 9 | 9 | 0.157 | 0.130 |
| Workers AI Qwen 3.8 27B | 8 | 10 | 10 | 3.336 | 1.782 |

The brief's approximate 0.16 s refers to the all-call median; the report records 0.130 s for work decisions alone.
This small synthetic evaluation supports role selection, not production quality or latency guarantees.
This change does not deploy the application or set a live secret.

## Web research provider decision - 2026-10-10

The captain approved the Cloudflare-first plan ("This is good") and asked not to overuse the paid OpenAI key.
Accepted: the research role uses OpenAI `gpt-4.1-mini-2025-04-14` with the Responses API `web_search` tool through the server-only `OPENAI_API_KEY`; no other role can select OpenAI.
The planner decides whether a request needs web research, so a request that needs no web search makes no paid call.
Each workspace may start `SANCTUM_PAID_RESEARCH_CALLS_PER_DAY` paid calls per UTC day (default 2), and all workspaces together `SANCTUM_PAID_RESEARCH_CALLS_PER_DAY_TOTAL` (default 4), with at most 3 web searches per call; each call is reserved before it is sent, a spent allowance refuses the next call with a truthful result, and every call records its token usage.
The caps bound the worst case at about 120 calls, about USD 5.50 a month ([operations.md](operations.md#configuration)).
When a request needs both web research and actions, the first pass proposes the actions with their recipients and other targets from the request and may leave content fields for the research; the planner then fills the actions a second time from the cited research. When research is refused, no action is requested and the result says so.
Web research is untrusted: the second pass is offered only the actions the first pass planned from the request, may change only their content fields, and any changed recipient, destination, account or other argument, or any added or dropped action, means no action is requested and the result says why.
Both planner passes use the `planner` role; this slice merges after the planner swap (`fm/sanctum-planner-qwen`), which makes that role Workers AI Qwen.
The plan estimated about USD 3.17 a month for all added inference at light use (40 meetings, 80 research runs), of which about USD 1.38 is this research; recorded usage, not the estimate, shows actual cost.
Anthropic stays selectable for research with `RESEARCH_MODEL_PROVIDER=anthropic`.

## Still open

### Saved-meeting retention

How long should saved recordings and transcripts remain before automatic deletion?
No automatic expiration has been selected.
Do not infer permission to delete data.

### Speech outside detected meetings

Should all captured speech become provisional conversations, or should only detected meetings be archived?
If only detected meetings are archived, choose how long to hold speech while determining its meeting.
This unassigned-speech buffer is different from the browser queue of recordings waiting to upload.

## Deployment inputs

An actual deployment also needs a timezone, identity configuration, MySQL/R2/provider credentials, approved audio fixtures, and an authorized hosting target.
These secrets and production resources do not belong in this repository.

## Hosts decision — 2026-10-09

Accepted: the hosted app, `/api/v1` and `/mcp` move to `app.sanctum.42nights.dev`; the apex `sanctum.42nights.dev` is for the landing page and answers every other request with `308` to the same path and query on the app host.
The API and MCP stay on the app host, because a separate `api.*` host needs cross-origin cookies, CORS and a new MCP address ([operations.md](operations.md#cloudflare)).

## Meeting end decision — 2026-10-09

Accepted: a meeting ends in one of two ways, and both run the same close as `POST /api/v1/meetings/{id}/close` (finalize, recording, notes and memory).

- **End meeting control:** the listening page shows End meeting in its control row while a meeting is open, also while paused. After one confirmation it stops capture and ends the meeting with `POST /api/v1/meetings/{id}/end`, which carries a fence: the capture epoch and `fence_sample`, the last sample captured before the pause. The route is for the website only (not in OpenAPI, the SDKs or MCP) and answers 404 for an epoch of a listener outside the meeting's listener and capture group, and 403 unless the caller owns that listener. When the page never captured (a reload while paused), it sends the same request with no epoch and sample, and the server fences the epochs the meeting used; the plain close of the API, SDKs and MCP carries no fence. Either way the close seals at the end of the most recently ended epoch that the meeting uses. The fence is stored on the epoch (`capture_epochs.end_fence_from_sample` and `end_fence_sample`), not on the meeting, so merge and split need no fence copying. It is clamped to real time: at most the seconds since the server recorded the epoch's start (plus 5 s of clock allowance) at the epoch's sample rate, counted from the epoch's first sample (a known limit: an archive-only epoch registers after its audio was captured, so its elapsed time is undercounted), so audio the page captured but has not uploaded yet (a socket outage, the last partial chunk) stays fenced and a far-future fence is impossible. It is not stored for an epoch the server does not know or that ended before the meeting started. The server also fences every other epoch the meeting owns ranges in, from the meeting's first sample there to the end of that epoch (bounded by real time while it still runs), so late batch finals of a paused epoch join the meeting after Pause, Resume and End. The fence window runs from the ended meeting's first sample in that epoch (the sample of its start when it owns none there yet) to the clamped fence, so a later End of the epoch replaces the window. An unowned final of a fenced epoch that starts inside the window never opens a meeting; a final before the window is not fenced. When it lies within the boundary gap (5 minutes) before a range of a closing or closed meeting, it joins that meeting and extends its start. Otherwise it joins the meeting that currently owns the nearest earlier range of that epoch at or after the window start, whatever row that is after a merge or split, and is dropped when no such range exists; a final before the window goes through normal placement. A closing meeting is finalized with it; a finalized one is finalized again (the same path as a late final inside a sealed meeting), so its notes include the final. When a recording cut already exists for its current boundary revision, it first moves to the next revision (ranges copied, processing reset, one boundary event) so the cut, speaker refine, notes and memory are rebuilt; with no cut yet, the final joins the current revision, which is still to be built, so further late finals join it until a cut exists. Its `ended_at` does not move. Finals at or past the fence, and speech after an API close (which carries no fence), form meetings as usual.
- **Automatic close:** the worker closes an open meeting that has had no speech for 10 minutes, but only when the listener is quiet and not lagging. Quiet means either that ASR finished 10 minutes of audio past the last speech (silence), or that every epoch of the listener (or its capture group) is paused or stopped for 10 minutes with all audio after the last speech transcribed and uploaded. A provider outage or an upload backlog never closes a meeting. The meeting ends at its last speech. The setting is `engineeringDefaults.meetingIdleCloseMs` (default 10 minutes).

Before this decision, Pause kept a meeting open and the page had no way to close it, so notes, memory and the recording never ran for a page user.

## Detected-meeting ownership decision — 2026-10-08

Accepted: when Sanctum detects a meeting, the principal of the capturing listener gets `owner` access to it in the same transaction.
The meeting stays `restricted`; every other principal, including workspace owners and admins, still needs an explicit grant.
Before this decision, nobody could read a detected meeting, so Review, the listening header and the agent-work feed stayed empty.

## Speech output decision - 2026-10-10

Accepted: requested speech uses Cloudflare Workers AI Aura-2 (`@cf/deepgram/aura-2-en`).
See [operations configuration](operations.md#configuration) for the shared server-only credentials.
The Luna speaker returns mono PCM16 little-endian at 24 kHz with `encoding: linear16` and `container: none`.
The [release evidence](release-evidence.md#workers-ai-speech-output) records the live byte check and the response header discrepancy.
The adapter keeps each request abortable before headers and during streaming.
The request window, sentence generation, generation checks and browser cancellation remain unchanged.
The [provider failure policy](operations.md#configuration) applies to speech output too.
No deployment or secret change forms part of this cutover.

## Text model provider decision — 2026-10-08

Accepted: the voice and extraction roles (spoken replies, notes, memory and context) use Cloudflare Workers AI on the 42nights account, which Sanctum already runs on, so no new vendor account or card is needed.
Both roles default to the open-weight `@cf/qwen/qwen3.8-27b` through the OpenAI-compatible `/v1/chat/completions` endpoint: thinking off for voice, `reasoning_effort: low` for extraction.
Its model schema lists strict `json_schema` output with `name`, `schema` and `strict`, which is the form the client sends; the plan had already picked this model on Cerebras.
On the synthetic extraction, notes and voice fixtures it grounded the notes, resolved the relative dates and did not repeat the superseded decision in voice, but twice labeled a decision as a commitment; `@cf/openai/gpt-oss-120b` added a sentence that is not in the context to a spoken reply.
This is a 24-call smoke comparison, not a quality benchmark; the run is recorded in [release-evidence.md](release-evidence.md#workers-ai-text-models).
The general Cerebras client was removed; a decision-only client now serves the [spoken classifier](#spoken-classifier-provider-decision---2026-10-10).
Research moved to OpenAI in the [web research provider decision](#web-research-provider-decision---2026-10-10).

## Sign-in and workspace management decision — 2026-10-08

Accepted: sign-in uses standard OIDC for human login and a JWT-issuing OAuth authorization server for MCP, both selected by configuration ([operations.md](operations.md#configuration)).
Both providers below use one `iss` and one `sub` for the login ID token and the MCP access token, so one `principal_identities` row serves both.

- **Hosted (the self-serve offering):** WorkOS AuthKit is the login issuer and the MCP authorization server. The hosted site uses the WorkOS production environment, which needs a payment method on file and costs nothing under 1M monthly active users. Development uses the WorkOS staging environment only, with no customer traffic.
- **Self-hosted:** Better Auth runs embedded in the server on the existing MySQL. It is the OIDC issuer and, through its OAuth provider plugin, the MCP authorization server.
- **MCP default scopes on WorkOS:** WorkOS gives MCP clients no Sanctum scope names, so `SANCTUM_MCP_DEFAULT_SCOPES` is `context:read,context:write,recordings:read`. No actions scope is granted by default.
- **Account and workspace management:** use the providers, do not build it. Hosted uses the WorkOS AuthKit profile and WorkOS Organizations; self-hosted uses the Better Auth organization plugin. Glue maps provider organizations, members and roles onto Sanctum workspaces, principals and `workspace_members`, which stay the only input to authorization. Membership never comes from an email domain.
- **Self-serve workspace creation (hosted):** on, now that the Sanctum-side seat limit has shipped; the hosted site sets `SANCTUM_SELF_SERVE_WORKSPACES=true` (`deploy/cloudflare/wrangler.jsonc`), and the default elsewhere is off.
- **Seat limits:** none while self-serve is off. Before self-serve opens, Sanctum enforces a seat limit per workspace at membership creation, configurable per workspace with a default.
- **Workspace deletion:** a soft delete revokes all memberships, sessions and agent credentials at once; a durable purge job later deletes the R2 objects and rows and writes a receipt. Nothing is purged automatically while meeting retention is open. Deleting a provider organization only detaches its link and never starts a purge.
- **Billing:** none now. Use Stripe Billing when paid plans exist.

Rejected: Logto and ZITADEL need PostgreSQL; Keycloak is a separate Java service outside the one Node image.
Meeting retention and speech outside detected meetings stay open, so production activation still refuses to start.
WorkOS sign-in replaced the hosted secret login link, which is removed.

## Speech-to-text decision — 2026-10-08

Accepted: live and batch speech-to-text use Whisper (`@cf/openai/whisper-large-v3-turbo`) on Cloudflare Workers AI in the 42nights account that already runs Sanctum.
The reason is the owner's preference for open-source or free tools and no new vendor: Whisper is open source, and the account needs no new card.
The daily free allocation is 10,000 neurons (about 200 audio minutes); after that, the cost is about $0.0005 per audio minute.
The Deepgram adapter is removed; no second live provider stays configured.
Whisper is batch-only, so the live transcript updates once per short chunk instead of word by word, and every live result is final.
Diarization does not change: Whisper returns no speaker labels, and pyannote stays optional and off.

Chunk measurement on 2026-10-08, with a 22 s synthetic speech clip at normal level and at -20 dB (word error rate against the script; the whole clip in one request gives 0.028 at both levels):

| Live chunk | Normal | -20 dB |
| --- | --- | --- |
| Fixed 2 s | 0.085 | 0.113 |
| Fixed 3 s | 0.070 | 0.085 |
| Fixed 5 s | 0.056 | 0.070 |
| Fixed 3 s with 0.5 s overlap | 0.211 | not run |
| Cut at the quietest 20 ms between 1.5 s and 2.5 s | 0.028 | 0.028 |

Fixed cuts split words, and the 2 s cut lost the word "Sanctum" from the direct request; overlap repeats words.
Sanctum therefore cuts each live chunk at the quietest 20 ms between 1.5 s and 2.5 s (`engineeringDefaults.liveAsr`).
Results keep audio order, so one slow answer holds back every later chunk.
Production runs on 2026-10-09 (44.1 kHz browser audio) measured answers of 2–8 s, median about 3.7 s, and about 1 answer in 100 after 12 s or never.
With three chunks in flight, one 12 s answer stopped new requests until the send backlog (512 KiB, 5.9 s of 44.1 kHz audio) reported `asr_backlog`.
Up to eight chunks are therefore in flight, and a chunk without an answer after `hedgeMs` (8 s) is sent again; the first answer wins, but the duplicate never wins by failing and is not sent during a 429 pause.
Whisper invents text such as "Thank you." on silence; `vad_filter` removes it without a change to the error rate above.
In production, `vad_filter` still let "You" and "Thank you." through on near-silent audio.
Sanctum therefore also drops a segment whose `no_speech_prob` is above 0.6, Whisper's `no_speech_threshold`.
The provider ignores `avg_logprob`, so confident filler on silence is dropped too.
A direct request can end in a later chunk, so the speech gate waits `turnWaitMs` for the next chunk's results before it ends a turn.

Cost control: the free allocation covers about 200 audio minutes a day, and an always-on listener sends up to 1,440, so silence must not be sent.
Before every Whisper request, live and `transcript.reconcile`, the adapter looks for 100 ms of consecutive 20 ms windows at `speechFloorRms` (`engineeringDefaults.liveAsr`, default 50 PCM16 RMS, about -56 dBFS, under quiet speech and above room noise); without it no request is made.
One loud 20 ms window is not enough: a click or tap in a quiet chunk is shorter than a word, and the synthetic test speech at -40 dB still passes in every 2.5 s chunk.
A skipped live chunk emits no text but still records coverage (see below), and a skipped batch range stays an empty transcript window.
Past the allocation, requests cost about $0.0005 per audio minute (about $0.62 a day for the 1,240 minutes beyond it, for a listener that never goes quiet); the gate keeps a mostly quiet room far below that.
A 429 stops requests for its `Retry-After`, else `rateLimitBackoffMs` (30 s); the live stream stays open, skipped chunks are reported as `transcription_behind` (`asr_backlog`), and archive reconciliation transcribes them later.
After any `degraded` frame, the first live answer for audio at or after its `from_sample` (also an empty answer for silence) sends `recovered`, and the page clears the warning; an old lane's late answers do not count.
A live chunk Whisper answered or the gate skipped records coverage for its whole span in the same write as its text, so `transcript.reconcile` does not re-send the gaps between its segments, and a failed write leaves the whole chunk uncovered for reconciliation; a chunk skipped by a 429 stays uncovered too.
A final window inside a meeting that closed before its transcript was complete (a live answer after the close, or reconciliation) finalizes that meeting again, so its transcript status, notes and memory include that text.

## Workspace deletion decision — 2026-10-09

Accepted: a workspace owner deleting the workspace deletes all its data, including meetings restricted to other principals; one owner suffices.
The grace-period undo protects against mistakes; after it, a durable `workspace.purge` job deletes the recordings, transcripts, memory and rows.
This is not a retention policy: no recording expires automatically.
The purge makes no provider call: it does not disconnect Pipedream-connected accounts, so an operator removes them in Pipedream before the grace period ends ([operations.md](operations.md#recovery)).

## Deployment decision — 2026-10-02

Accepted: Sanctum runs on Cloudflare Containers behind a Worker in the 42nights account and serves `sanctum.42nights.dev`; the 42nights.dev domain moves into that account.
MySQL is an Aiven MySQL 8.4 service reached only over TLS verified with its project CA; recordings stay in a private R2 bucket in the same account.
Anyone may open the site; visitors without a session are signed out.
This selects no sign-in issuer or any other decision; the deployment runs in development mode ([operations.md](operations.md#cloudflare)).

## Runtime decision — 2026-09-28

Accepted: all-TypeScript application with Effect, replacing the earlier mixed-language plan.
Cloud speech/model APIs remove the need for a Python inference service.
Shared wire schemas reduce contract drift across browser, API, workers and agent adapters.
The alternative of keeping a Python voice service was rejected to keep one application runtime.
Consequences: implement and test turn detection, interruption, echo protection and reconnect explicitly.
Effect handles in-process concurrency and cleanup; MySQL remains responsible for durable jobs and receipts.
The Python SDK remains a client deliverable, isolated from server images and ordinary documentation CI.
