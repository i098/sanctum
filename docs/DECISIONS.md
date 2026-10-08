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

## Detected-meeting ownership decision — 2026-10-08

Accepted: when Sanctum detects a meeting, the principal of the capturing listener gets `owner` access to it in the same transaction.
The meeting stays `restricted`; every other principal, including workspace owners and admins, still needs an explicit grant.
Before this decision, nobody could read a detected meeting, so Review, the listening header and the agent-work feed stayed empty.

## Text model provider decision — 2026-10-08

Accepted: the voice and extraction roles (spoken replies, notes, memory and context) use Cloudflare Workers AI on the 42nights account, which Sanctum already runs on, so no new vendor account or card is needed.
Both roles default to the open-weight `@cf/qwen/qwen3.8-27b` through the OpenAI-compatible `/v1/chat/completions` endpoint: thinking off for voice, `reasoning_effort: low` for extraction.
Its model schema lists strict `json_schema` output with `name`, `schema` and `strict`, which is the form the client sends; the plan had already picked this model on Cerebras.
On the synthetic extraction, notes and voice fixtures it grounded the notes, resolved the relative dates and did not repeat the superseded decision in voice, but twice labeled a decision as a commitment; `@cf/openai/gpt-oss-120b` added a sentence that is not in the context to a spoken reply.
This is a 24-call smoke comparison, not a quality benchmark; the run is recorded in [release-evidence.md](release-evidence.md#workers-ai-text-models).
The Cerebras client is removed; Anthropic stays selectable with `<ROLE>_MODEL_PROVIDER=anthropic`, and planner and research stay on Anthropic.

## Sign-in and workspace management decision — 2026-10-08

Accepted: sign-in uses standard OIDC for human login and a JWT-issuing OAuth authorization server for MCP, both selected by configuration ([operations.md](operations.md#configuration)).
Both providers below use one `iss` and one `sub` for the login ID token and the MCP access token, so one `principal_identities` row serves both.

- **Hosted (the self-serve offering):** WorkOS AuthKit is the login issuer and the MCP authorization server. The hosted site uses the WorkOS production environment, which needs a payment method on file and costs nothing under 1M monthly active users. Development uses the WorkOS staging environment only, with no customer traffic.
- **Self-hosted:** Better Auth runs embedded in the server on the existing MySQL. It is the OIDC issuer and, through its OAuth provider plugin, the MCP authorization server.
- **MCP default scopes on WorkOS:** WorkOS gives MCP clients no Sanctum scope names, so `SANCTUM_MCP_DEFAULT_SCOPES` is `context:read,context:write,recordings:read`. No actions scope is granted by default.
- **Account and workspace management:** use the providers, do not build it. Hosted uses the WorkOS AuthKit profile and WorkOS Organizations; self-hosted uses the Better Auth organization plugin. Glue maps provider organizations, members and roles onto Sanctum workspaces, principals and `workspace_members`, which stay the only input to authorization. Membership never comes from an email domain.
- **Self-serve workspace creation (hosted):** on, but only after the Sanctum-side seat limit ships.
- **Seat limits:** none while self-serve is off. Before self-serve opens, Sanctum enforces a seat limit per workspace at membership creation, configurable per workspace with a default.
- **Workspace deletion:** a soft delete revokes all memberships, sessions and agent credentials at once; a durable purge job later deletes the R2 objects and rows and writes a receipt. Nothing is purged automatically while meeting retention is open. Deleting a provider organization only detaches its link and never starts a purge.
- **Billing:** none now. Use Stripe Billing when paid plans exist.

Rejected: Logto and ZITADEL need PostgreSQL; Keycloak is a separate Java service outside the one Node image.
Meeting retention and speech outside detected meetings stay open, so production activation still refuses to start.
The hosted secret login link stays until WorkOS sign-in replaces it.

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
Requests take about 1.5–3 s with peaks near 9 s, so up to three chunks are in flight, and results keep audio order.
Whisper invents text such as "Thank you." on silence; `vad_filter` removes it without a change to the error rate above.
A direct request can end in a later chunk, so the speech gate waits `turnWaitMs` for the next chunk's results before it ends a turn.

## Deployment decision — 2026-10-02

Accepted: Sanctum runs on Cloudflare Containers behind a Worker in the 42nights account and serves `sanctum.42nights.dev`; the 42nights.dev domain moves into that account.
MySQL is an Aiven MySQL 8.4 service reached only over TLS verified with its project CA; recordings stay in a private R2 bucket in the same account.
Anyone may open the site; until sign-in is configured on the deployment, a secret login link hands the browser a pre-seeded owner session, and visitors without it have no session.
This selects no sign-in issuer or any other decision; the deployment runs in development mode ([operations.md](operations.md#cloudflare)).

## Runtime decision — 2026-09-28

Accepted: all-TypeScript application with Effect, replacing the earlier mixed-language plan.
Cloud speech/model APIs remove the need for a Python inference service.
Shared wire schemas reduce contract drift across browser, API, workers and agent adapters.
The alternative of keeping a Python voice service was rejected to keep one application runtime.
Consequences: implement and test turn detection, interruption, echo protection and reconnect explicitly.
Effect handles in-process concurrency and cleanup; MySQL remains responsible for durable jobs and receipts.
The Python SDK remains a client deliverable, isolated from server images and ordinary documentation CI.
