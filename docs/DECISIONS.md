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

### Sign-in provider

This means how people log in and prove who they are.
Google OIDC is a proposed default, not an approved choice.
Pipedream app connections do not establish membership in a Sanctum team.
Remote MCP also needs a maintained authorization server with resource-audience support; human OIDC login alone does not supply that server.
Select and configure both roles before enabling production delegated access.

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

## Deployment decision — 2026-10-02

Accepted: Sanctum runs on Cloudflare Containers behind a Worker in the 42nights account and serves `sanctum.42nights.dev`; the 42nights.dev domain moves into that account.
MySQL is an Aiven MySQL 8.4 service reached only over TLS verified with its project CA; recordings stay in a private R2 bucket in the same account.
Anyone may open the site; until a sign-in issuer is selected, a secret login link hands the browser a pre-seeded owner session, and visitors without it have no session.
This does not select the sign-in issuer or any other open decision; the deployment runs in development mode ([operations.md](operations.md#cloudflare)).

## Runtime decision — 2026-09-28

Accepted: all-TypeScript application with Effect, replacing the earlier mixed-language plan.
Cloud speech/model APIs remove the need for a Python inference service.
Shared wire schemas reduce contract drift across browser, API, workers and agent adapters.
The alternative of keeping a Python voice service was rejected to keep one application runtime.
Consequences: implement and test turn detection, interruption, echo protection and reconnect explicitly.
Effect handles in-process concurrency and cleanup; MySQL remains responsible for durable jobs and receipts.
The Python SDK remains a client deliverable, isolated from server images and ordinary documentation CI.
