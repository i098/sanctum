# Operations

How to run, check and recover Sanctum.
Nothing here authorizes a deployment, a production migration, paid services or live recording; those need their own approval (see [DECISIONS.md](DECISIONS.md)).

## Processes

One Node image serves two entrypoints ([server/Dockerfile](../server/Dockerfile), [docker-compose.yml](../docker-compose.yml)):

- `api` (`server/src/main.ts`): `/api/v1`, `/mcp`, the listener WebSocket upgrade and the built website, all on one port behind Caddy.
- `worker` (`server/src/worker.ts`): the durable MySQL job ledger (notes, recording assembly, transcript reconciliation, speakers, context, memory, matching, actions).

Both refuse to start in `SANCTUM_ENV=production` until every open decision is listed in `SANCTUM_SELECTED_DECISIONS` (`identity_issuer`, `mcp_authorization_server`, `meeting_retention`, `outside_meeting_speech`).
The worker also refuses to start while migrations are pending; `/readyz` reports pending migrations as not ready.

## Configuration

Secrets come from the environment only; none are committed.

| Group | Variables |
| --- | --- |
| Core | `SANCTUM_ENV`, `SANCTUM_SELECTED_DECISIONS`, `API_PORT`, `SANCTUM_ALLOWED_ORIGINS` |
| MySQL | `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_POOL_SIZE`, `MYSQL_POOL_QUEUE` |
| Recordings (R2) | `R2_ENDPOINT`, `R2_BUCKET`, `R2_PREFIX`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_TIMEOUT_MS` |
| Speech | `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL`, `DEEPGRAM_URL`, `DEEPGRAM_BATCH_TIMEOUT_MS`, `PYANNOTE_API_KEY`, `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID` |
| Models | `CEREBRAS_API_KEY`, `ANTHROPIC_API_KEY`, `<ROLE>_MODEL_PROVIDER`, `<ROLE>_MODEL` for voice, extraction, planner, research |
| Integrations | `PIPEDREAM_API_URL`, `PIPEDREAM_ENVIRONMENT`, `PIPEDREAM_PROJECT_ID`, `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET` |
| Remote MCP | `SANCTUM_MCP_ISSUER`, `SANCTUM_MCP_JWKS_URL`, `SANCTUM_MCP_RESOURCE` |

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

## Migrations

Run migrations explicitly (`npm run migrate --workspace server`, or `server/dist/migrate.js` in the image); neither entrypoint applies DDL on startup.
Each file is split into single-object steps recorded in `schema_migrations` and `schema_migration_steps` under a per-schema named lock.
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
- **API restart**: browsers reconnect with the same capture epoch and resume from the server's live watermark; chunks waiting in IndexedDB upload with their original IDs and are deduplicated by hash.
- **Browser killed or offline without a stop**: once the listener's lease lapses, the worker sweeper ends its open epoch as `interrupted` and seals the meeting; a device that returns after that starts a new epoch, so the stored gap stays visible.
- **R2 write succeeded but the manifest did not**: the retried upload finds the object with `head` and completes the manifest; a conflicting hash is rejected.
- **Provider outage**: live ranges are marked degraded and recovered by `transcript.reconcile` from uploaded chunks.
- **Rollback**: set `SANCTUM_IMAGE` to the previous validated tag and `docker compose up -d api worker`; data volumes and R2 objects are untouched and migrations are never reversed, so a previous image must support the current schema.

## Not yet selected

The sign-in issuer, MCP authorization server, saved-meeting retention and speech outside detected meetings remain open ([DECISIONS.md](DECISIONS.md)).
Until they are selected, production activation is refused, no recording expires automatically, and automatically detected meetings start restricted with no grants.
