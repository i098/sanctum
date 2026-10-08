# Operations

How to run, check and recover Sanctum.
Nothing here authorizes a new deployment, a production migration, paid services or live recording; those need their own approval (see [DECISIONS.md](DECISIONS.md)).

## Processes

One Node image serves two entrypoints ([server/Dockerfile](../server/Dockerfile), [docker-compose.yml](../docker-compose.yml), [Cloudflare](#cloudflare)):

- `api` (`server/src/main.ts`): `/api/v1`, `/mcp`, the listener WebSocket upgrade and the built website, all on one port behind Caddy.
- `worker` (`server/src/worker.ts`): the durable MySQL job ledger (notes, recording assembly, transcript reconciliation, speakers, context, memory, matching, actions).

Both refuse to start in `SANCTUM_ENV=production` until every open decision is listed in `SANCTUM_SELECTED_DECISIONS` (`identity_issuer`, `mcp_authorization_server`, `meeting_retention`, `outside_meeting_speech`).
The worker also refuses to start while migrations are pending; `/readyz` reports pending migrations as not ready.

## Configuration

Secrets come from the environment only; none are committed.

| Group | Variables |
| --- | --- |
| Core | `SANCTUM_ENV`, `SANCTUM_SELECTED_DECISIONS`, `API_PORT`, `SANCTUM_ALLOWED_ORIGINS` |
| MySQL | `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_POOL_SIZE`, `MYSQL_POOL_QUEUE`, `MYSQL_CA_CERT` (PEM text; when set, TLS is required and the server certificate and host name are verified) |
| Recordings (R2) | `R2_ENDPOINT`, `R2_BUCKET`, `R2_PREFIX`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_TIMEOUT_MS` |
| Speech | `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL`, `DEEPGRAM_URL`, `DEEPGRAM_BATCH_TIMEOUT_MS`, `PYANNOTE_API_KEY`, `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID` |
| Models | `WORKERS_AI_ACCOUNT_ID`, `WORKERS_AI_API_TOKEN` (Cloudflare API token with only Workers AI permission; voice and extraction by default), `ANTHROPIC_API_KEY`, `<ROLE>_MODEL_PROVIDER` (`workers-ai` or `anthropic`), `<ROLE>_MODEL` for voice, extraction, planner, research |
| Integrations | `PIPEDREAM_API_URL`, `PIPEDREAM_ENVIRONMENT`, `PIPEDREAM_PROJECT_ID`, `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET` |
| Remote MCP | `SANCTUM_MCP_ISSUER`, `SANCTUM_MCP_JWKS_URL`, `SANCTUM_MCP_RESOURCE`, `SANCTUM_MCP_DEFAULT_SCOPES` (comma list granted only to tokens that name no Sanctum scope, such as WorkOS DCR/CIMD clients; always narrowed by role and never `workspace:admin` or `capture:ingest`; empty by default; when set, metadata and challenges stop naming scopes) |

A missing provider key never falls back to another provider or to invented output: the affected call fails as `Unavailable`, jobs record the failure, and no audio is spoken.
Engineering defaults (chunk length, heartbeat and lease, context debounce, playback URL lifetime) live in `engineeringDefaults` in [server/src/config.ts](../server/src/config.ts).

## Local stack

```bash
npm ci
npm run dev -w web-app                                  # website on 3102, proxying /api to 7102
MYSQL_PASSWORD=... SANCTUM_ENV=development docker compose up -d mysql
MYSQL_PASSWORD=... SANCTUM_ENV=development docker compose run --rm api node server/dist/migrate.js
MYSQL_PASSWORD=... SANCTUM_ENV=development docker compose up -d api worker caddy
```

## Cloudflare

The deployed instance runs in the 42nights Cloudflare account from [deploy/cloudflare](../deploy/cloudflare): Worker `sanctum`, Container applications for `SanctumApi` and `SanctumJobs` (same image, one instance each), MySQL on Aiven over verified TLS (database `sanctum`), recordings in the private R2 bucket `sanctum-recordings`.
It serves only `https://sanctum.42nights.dev` (a Workers custom domain declared in `wrangler.jsonc`, attached on deploy); `workers_dev` is off.

- **Routing**: the Worker answers `/__login/<LOGIN_TOKEN>` itself and sends every other request, including the listener WebSocket, to the API container. No sign-in issuer is selected, so that link sets the pre-seeded owner session (`sanctum_session`, HttpOnly) and `sanctum_csrf`; anyone without it reaches the app with no session.
- **Job worker**: has no port and is never stopped for inactivity; a cron every five minutes starts it again after a crash or rollout. State lives in MySQL and R2; container disk is disposable.
- **Mode**: `SANCTUM_ENV=development` (production refuses to start while decisions are open); no provider keys, so transcription, notes and voice report unavailable.
- **Deploy** (Docker must be usable by the deploying user, or set `WRANGLER_DOCKER_BIN` to a wrapper): from `deploy/cloudflare`, `npx wrangler deploy`. Wrangler builds `server/Dockerfile`, pushes it to the account registry and rolls out both containers.
- **Secrets** (`npx wrangler secret put NAME`, read from stdin): `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_CA_CERT` (the provider's project CA, PEM), `R2_ENDPOINT` (`https://<account>.r2.cloudflarestorage.com`), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (an account API token limited to the bucket: its ID and the SHA-256 of its value), `LOGIN_TOKEN`, `SESSION_TOKEN`, `CSRF_TOKEN`, `WORKERS_AI_API_TOKEN` (notes, memory, context and voice text; without it they report unavailable). Non-secret settings, including `WORKERS_AI_ACCOUNT_ID`, are `vars` in [wrangler.jsonc](../deploy/cloudflare/wrangler.jsonc). Optional provider keys: `DEEPGRAM_API_KEY` (transcription), `ANTHROPIC_API_KEY` (planner and research), `CARTESIA_API_KEY` with `CARTESIA_VOICE_ID` (speech), `PIPEDREAM_PROJECT_ID`, `PIPEDREAM_CLIENT_ID` and `PIPEDREAM_CLIENT_SECRET` (actions), `PYANNOTE_API_KEY` with `SANCTUM_DIARIZATION=pyannote` (diarization). Non-secret settings are `vars` in [wrangler.jsonc](../deploy/cloudflare/wrangler.jsonc). The Worker forwards to both containers only the settings listed in [settings.ts](../deploy/cloudflare/src/settings.ts), including the model choices (`<ROLE>_MODEL_PROVIDER`, `<ROLE>_MODEL`, `DEEPGRAM_MODEL`); an unset setting keeps the app default.
- **Migrate** before deploying a new schema, with the image's own entrypoint and the CA mounted read-only: `docker run --rm --env-file <(...) -v "$CA:/ca.pem:ro" <image> sh -c 'MYSQL_CA_CERT="$(cat /ca.pem)" exec node server/dist/migrate.js'`, where the env file holds the same `MYSQL_*` values. The job worker refuses to start while migrations are pending.
- **Owner session**: one workspace, one human principal with an `owner` membership and one `browser_sessions` row whose `id_hash` and `csrf_hash` are the SHA-256 of `SESSION_TOKEN` and `CSRF_TOKEN` (expiring after a year, like the cookies). Revoke it by setting `revoked_at`; rotate by inserting a new row and replacing the three token secrets.
- **Logs**: `npx wrangler tail sanctum` for the Worker; container stdout and stderr appear in the dashboard under Workers & Pages → `sanctum` → Containers, and in Workers observability. Workers invocation logs are off (`observability.logs.invocation_logs`) because they record the full request URL, which would store `/__login/<LOGIN_TOKEN>`; `wrangler tail` still shows live request URLs, so do not tail while using the link.
- **Rollback**: check out the previous validated commit and `npx wrangler deploy` from it; that rebuilds its image and rolls both containers back with the Worker (`wrangler rollback` alone reverts only the Worker script, not the container image). Migrations are never reversed, so a previous image must support the current schema; MySQL and R2 data are untouched.

## Migrations

Run migrations explicitly (`npm run migrate --workspace server`, or `server/dist/migrate.js` in the image); neither entrypoint applies DDL on startup.
Each file is split into single-object steps (`CREATE TABLE`, `CREATE INDEX`, or `ALTER TABLE ... ADD COLUMN` for one column) recorded in `schema_migrations` and `schema_migration_steps` under a per-schema named lock.
After an interruption, rerun the same command: finished steps are skipped, an object created before its ledger row is adopted, and an object created outside the ledger stops the run.
Never edit an applied migration (its checksum is verified), and never roll back by dropping tables.

## Checks

| Command | What it proves |
| --- | --- |
| `npm run check` | Types, handoff structure, links, generated documentation. |
| `npm run check:app` | Workspace typechecks, all Vitest suites against MySQL 8.4, the web build, Playwright in Chromium, the benchmark manifest, benchmark correctness smoke, and the accelerated 24-hour replay. Set `SANCTUM_TEST_MYSQL_URL` for the last two. |
| `node scripts/benchmark.ts --mysql-url ...` | Full-scale TypeScript benchmark records (see [benchmarks/README.md](../benchmarks/README.md)). |
| `node scripts/replay-capture.ts --fixture server/tests/fixtures/day.json --accelerated` | A day of synthetic source time: meeting boundaries and one owner per segment (RSS growth reported, not gated). |
| `npm run sdk:generate -- --check` | Generated TypeScript and Python SDKs match the v1 OpenAPI document. |

Under heavy host load, run Playwright with `--workers=1`; timing-sensitive specs poll for settled state.

## Recovery

- **Worker crash or restart**: leases expire and the sweeper returns running jobs to pending; handlers are idempotent per work key, and an action whose outcome is unknown stays `unknown` until a person resolves it.
- **API restart**: browsers that return within the ownership lease reconnect with the same capture epoch and resume from the server's live watermark; after a longer outage the worker has already ended the epoch as below, so they start a new one. Chunks waiting in IndexedDB upload with their original IDs and are deduplicated by hash.
- **Browser killed or offline without a stop**: once the listener's lease lapses, the worker sweeper ends its open epoch as `interrupted` and seals the meeting; a device that returns after that starts a new epoch, so the stored gap stays visible.
- **R2 write succeeded but the manifest did not**: the retried upload finds the object with `head` and completes the manifest; a conflicting hash is rejected.
- **Provider outage**: live ranges are marked degraded and recovered by `transcript.reconcile` from uploaded chunks.
- **Rollback**: set `SANCTUM_IMAGE` to the previous validated tag and `docker compose up -d api worker`; data volumes and R2 objects are untouched and migrations are never reversed, so a previous image must support the current schema.

## Not yet selected

The sign-in issuer, MCP authorization server, saved-meeting retention and speech outside detected meetings remain open ([DECISIONS.md](DECISIONS.md)).
Until they are selected, production activation is refused and no recording expires automatically.
