# Operations

How to run, check and recover Sanctum.
Nothing here authorizes a new deployment, a production migration, paid services or live recording; those need their own approval (see [DECISIONS.md](DECISIONS.md)).

## Processes

One Node image serves two entrypoints ([server/Dockerfile](../server/Dockerfile), [docker-compose.yml](../docker-compose.yml), [Cloudflare](#cloudflare)):

- `api` (`server/src/main.ts`): `/api/v1`, `/mcp`, the listener WebSocket upgrade, the built website and, when [self-hosted sign-in](#self-hosted-sign-in) is on, the embedded issuer at `/idp`, all on one port behind Caddy.
- `worker` (`server/src/worker.ts`): the durable MySQL job ledger (notes, recording assembly, transcript reconciliation, speakers, context, memory, matching, actions).

Both refuse to start in `SANCTUM_ENV=production` until every decision is listed in `SANCTUM_SELECTED_DECISIONS` (`identity_issuer`, `mcp_authorization_server`, `meeting_retention`, `outside_meeting_speech`).
In every environment, both refuse to start when a listed decision lacks its settings, and the error names each missing variable: `identity_issuer` needs `SANCTUM_OIDC_ISSUER`, `SANCTUM_OIDC_CLIENT_ID` and `SANCTUM_OIDC_REDIRECT_URI` (plus `BETTER_AUTH_SECRET` with the embedded issuer); `mcp_authorization_server` needs the three `SANCTUM_MCP_*` URLs.
The worker also refuses to start while migrations are pending; `/readyz` reports pending migrations as not ready.

## Configuration

Secrets come from the environment only; none are committed.

| Group | Variables |
| --- | --- |
| Core | `SANCTUM_ENV`, `SANCTUM_SELECTED_DECISIONS`, `API_PORT`, `SANCTUM_ALLOWED_ORIGINS` |
| Workspaces | `SANCTUM_DEFAULT_SEAT_LIMIT`: owner, admin and member seats per workspace; a positive integer, unset for no limit (the hosted Worker sets `5` in `deploy/cloudflare/wrangler.jsonc`). A workspace's own `workspaces.seat_limit` overrides it (operator SQL; NULL uses the default). A malformed value stops startup. A member beyond the limit is refused with `SeatLimitReached`; existing members stay. |
| MySQL | `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_POOL_SIZE`, `MYSQL_POOL_QUEUE`, `MYSQL_CA_CERT` (PEM text; when set, TLS is required and the server certificate and host name are verified) |
| Recordings (R2) | `R2_ENDPOINT`, `R2_BUCKET`, `R2_PREFIX`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_TIMEOUT_MS` |
| Speech | `PYANNOTE_API_KEY`, `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID` |
| Models | `WORKERS_AI_ACCOUNT_ID`, `WORKERS_AI_API_TOKEN` (Cloudflare API token with only Workers AI permission; Whisper speech-to-text, live and batch, and voice and extraction by default), `ANTHROPIC_API_KEY`, `<ROLE>_MODEL_PROVIDER` (`workers-ai` or `anthropic`), `<ROLE>_MODEL` for voice, extraction, planner, research |
| Integrations | `PIPEDREAM_API_URL`, `PIPEDREAM_ENVIRONMENT`, `PIPEDREAM_PROJECT_ID`, `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET` |
| Sign-in | `SANCTUM_OIDC_ISSUER` (exact ID token `iss`; discovery at `/.well-known/openid-configuration` under it), `SANCTUM_OIDC_CLIENT_ID`, `SANCTUM_OIDC_REDIRECT_URI` (`https://<host>/auth/callback`); sign-in is enabled only when all three are set, otherwise `/auth/login` answers `503`; `SANCTUM_OIDC_CLIENT_SECRET` (omit for a public client, which uses PKCE), `SANCTUM_OIDC_SCOPES` (default `openid profile email`), `SANCTUM_EMBEDDED_ISSUER` (`better-auth` serves the self-hosted issuer at `/idp`; reported by `GET /auth/config`), `BETTER_AUTH_SECRET` (at least 32 characters, needed when the embedded issuer is selected) |
| Remote MCP | `SANCTUM_MCP_ISSUER`, `SANCTUM_MCP_JWKS_URL`, `SANCTUM_MCP_RESOURCE`, `SANCTUM_MCP_DEFAULT_SCOPES` (comma list granted only to tokens that name no Sanctum scope, such as WorkOS DCR/CIMD clients; always narrowed by role and never `workspace:admin` or `capture:ingest`; empty by default; when set, metadata and challenges stop naming scopes) |

WorkOS AuthKit (hosted) and embedded Better Auth (self-hosted) both use one value for `SANCTUM_OIDC_ISSUER` and `SANCTUM_MCP_ISSUER`; when the two differ, an identity linked at login does not authorize MCP.
The sign-in routes read the Sign-in group; a partial `SANCTUM_OIDC_*` set does not stop startup unless `identity_issuer` is listed, and sign-in then stays off.
With `SANCTUM_EMBEDDED_ISSUER` set, the embedded issuer reads `SANCTUM_OIDC_ISSUER`, `SANCTUM_MCP_RESOURCE` and `BETTER_AUTH_SECRET`, and `/mcp` reads the `SANCTUM_MCP_*` settings; `issuer:client` also reads `SANCTUM_OIDC_REDIRECT_URI`.

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

## Self-hosted sign-in

`SANCTUM_EMBEDDED_ISSUER=better-auth` mounts Better Auth ([server/src/issuer.ts](../server/src/issuer.ts)) in the API process at `/idp`: the OIDC issuer for website sign-in and the OAuth authorization server for `/mcp`.
It uses the existing MySQL through its own two-connection pool and the `auth_*` tables of migration `011_embedded_issuer`; run migrations first. Sanctum never runs Better Auth's own migrator.

| Setting | Value |
| --- | --- |
| `SANCTUM_EMBEDDED_ISSUER` | `better-auth` |
| `BETTER_AUTH_SECRET` | At least 32 random characters, for example `openssl rand -base64 32`. Signs issuer state and encrypts the stored signing keys, so keep it stable. |
| `SANCTUM_OIDC_ISSUER`, `SANCTUM_MCP_ISSUER` | `https://<host>/idp` (the API refuses to start when the embedded issuer path is not `/idp`) |
| `SANCTUM_MCP_RESOURCE` | `https://<host>/mcp`, the audience of every MCP access token |
| `SANCTUM_MCP_JWKS_URL` | `https://<host>/idp/jwks` (EdDSA keys) |

- **Discovery**: `/idp/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server/idp` advertise PKCE `S256`, dynamic client registration at `/idp/oauth2/register` and Client ID Metadata Documents.
- **Pages**: Better Auth sends browsers to `/sign-in`, `/sign-up` and `/consent` on the website during an authorization request.
- **Website client**: with the settings above plus `SANCTUM_OIDC_REDIRECT_URI=https://<host>/auth/callback`, run `npm run issuer:client -w server`. It registers a public client (PKCE, no consent screen) and prints the id for `SANCTUM_OIDC_CLIENT_ID`; leave `SANCTUM_OIDC_CLIENT_SECRET` unset. Each run registers another client.
- **MCP clients** register themselves (open registration or a metadata document URL). A registration without `application_type` whose redirect URIs are all `http` loopback URIs (`localhost`, `127.0.0.1`, `[::1]`, any port) is registered as `native`; every other registration keeps the OIDC default `web`, which allows only `https` redirects. Access tokens carry only the Sanctum scopes the user approved for the `/mcp` resource.
- **Client scopes**: an authorization request that names no `scope` is offered only the OIDC scopes plus `context:read`, `context:write` and `recordings:read`, for every client (registered, metadata document or `issuer:client`). While `SANCTUM_MCP_DEFAULT_SCOPES` is unset, the `/mcp` 401 challenge names every MCP scope except `actions:request` and `actions:execute`, and the resource metadata lists every supported scope. Setting `SANCTUM_MCP_DEFAULT_SCOPES=context:read,context:write,recordings:read` makes both stop naming scopes and grants those scopes to tokens that name no Sanctum scope. `actions:request` and `actions:execute` are granted only when a client names them in its authorization request.
- **Access**: an issuer account alone grants nothing. Its `(issuer, subject)` pair must be linked to a principal with an active membership in `principal_identities`; membership never comes from the email address.
- **Upgrades**: Better Auth versions are pinned. At startup it logs any difference between its expected schema and the database; an upgrade that needs more than new tables, indexes or columns is its own reviewed task.

## Cloudflare

The deployed instance runs in the 42nights Cloudflare account from [deploy/cloudflare](../deploy/cloudflare): Worker `sanctum`, Container applications for `SanctumApi` and `SanctumJobs` (same image, one instance each), MySQL on Aiven over verified TLS (database `sanctum`), recordings in the private R2 bucket `sanctum-recordings`.
It serves only `https://sanctum.42nights.dev` (a Workers custom domain declared in `wrangler.jsonc`, attached on deploy); `workers_dev` is off.

- **Routing**: the Worker answers `/__login/<LOGIN_TOKEN>` itself and sends every other request, including the listener WebSocket, to the API container. That link sets the pre-seeded owner session (`sanctum_session`, HttpOnly) and `sanctum_csrf`; it stays until WorkOS sign-in replaces it. Anyone without a session reaches the app signed out. The Worker forwards only the settings listed in [settings.ts](../deploy/cloudflare/src/settings.ts) and never the login tokens.
- **Sign-in and MCP authorization**: WorkOS AuthKit in the WorkOS production environment, AuthKit domain `merry-precipice-00.authkit.app`. The `SANCTUM_OIDC_*`, `SANCTUM_MCP_*` and `SANCTUM_SELECTED_DECISIONS` values are `vars` in [wrangler.jsonc](../deploy/cloudflare/wrangler.jsonc); `SANCTUM_OIDC_CLIENT_SECRET` is a Worker secret. The WorkOS dashboard (or the WorkOS API) must have:
  - a first-party Connect OAuth application (Connect → Applications) with the redirect URI `https://sanctum.42nights.dev/auth/callback`, PKCE off, and a client secret; its client ID is `SANCTUM_OIDC_CLIENT_ID`;
  - Dynamic Client Registration and Client ID Metadata Document both enabled (Connect → Configuration → MCP Auth);
  - the resource indicator `https://sanctum.42nights.dev/mcp`, set as the default (Connect → Configuration → MCP resource indicators);
  - sign-up enabled (Authentication → Features) and at least one sign-in method, here Magic Auth (Authentication → Methods);
  - a payment method on the WorkOS team, because the production environment needs one (no charge under 1M monthly active users).
  WorkOS lists `registration_endpoint` and `client_id_metadata_document_supported` only in `/.well-known/oauth-authorization-server`, not in `/.well-known/openid-configuration`.
- **Job worker**: has no port and is never stopped for inactivity; a cron every five minutes starts it again after a crash or rollout. State lives in MySQL and R2; container disk is disposable.
- **Mode**: `SANCTUM_ENV=development` (production refuses to start while decisions are open). Without `WORKERS_AI_API_TOKEN`, transcription, notes and voice report unavailable.
- **Deploy** (Docker must be usable by the deploying user, or set `WRANGLER_DOCKER_BIN` to a wrapper): from `deploy/cloudflare`, `npx wrangler deploy`. Wrangler builds `server/Dockerfile`, pushes it to the account registry and rolls out both containers.
- **Secrets** (`npx wrangler secret put NAME`, read from stdin): `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_CA_CERT` (the provider's project CA, PEM), `R2_ENDPOINT` (`https://<account>.r2.cloudflarestorage.com`), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (an account API token limited to the bucket: its ID and the SHA-256 of its value), `LOGIN_TOKEN`, `SESSION_TOKEN`, `CSRF_TOKEN`, `SANCTUM_OIDC_CLIENT_SECRET` (the WorkOS OAuth application's client secret), `WORKERS_AI_API_TOKEN` (speech-to-text, notes, memory, context and voice text; an account API token with only Workers AI permission; without it they report unavailable). Non-secret settings, including `WORKERS_AI_ACCOUNT_ID`, are `vars` in [wrangler.jsonc](../deploy/cloudflare/wrangler.jsonc). Optional provider keys: `ANTHROPIC_API_KEY` (planner and research), `CARTESIA_API_KEY` with `CARTESIA_VOICE_ID` (speech), `PIPEDREAM_PROJECT_ID`, `PIPEDREAM_CLIENT_ID` and `PIPEDREAM_CLIENT_SECRET` (actions), `PYANNOTE_API_KEY` with `SANCTUM_DIARIZATION=pyannote` (diarization). Non-secret settings are `vars` in [wrangler.jsonc](../deploy/cloudflare/wrangler.jsonc). The Worker forwards to both containers only the settings listed in [settings.ts](../deploy/cloudflare/src/settings.ts), including the model choices (`<ROLE>_MODEL_PROVIDER`, `<ROLE>_MODEL`); an unset setting keeps the app default.
- **Migrate** before deploying a new schema, with the image's own entrypoint and the CA mounted read-only: `docker run --rm --env-file <(...) -v "$CA:/ca.pem:ro" <image> sh -c 'MYSQL_CA_CERT="$(cat /ca.pem)" exec node server/dist/migrate.js'`, where the env file holds the same `MYSQL_*` values. The job worker refuses to start while migrations are pending.
- **Owner session**: one workspace, one human principal with an `owner` membership and one `browser_sessions` row whose `id_hash` and `csrf_hash` are the SHA-256 of `SESSION_TOKEN` and `CSRF_TOKEN` (expiring after a year, like the cookies). Revoke it by setting `revoked_at`; rotate by inserting a new row and replacing the three token secrets.
- **Logs**: `npx wrangler tail sanctum` for the Worker; container stdout and stderr appear in the dashboard under Workers & Pages → `sanctum` → Containers, and in Workers observability. Workers invocation logs are off (`observability.logs.invocation_logs`) because they record the full request URL, which would store `/__login/<LOGIN_TOKEN>`; `wrangler tail` still shows live request URLs, so do not tail while using the link.
- **Rollback**: check out the previous validated commit and `npx wrangler deploy` from it; that rebuilds its image and rolls both containers back with the Worker (`wrangler rollback` alone reverts only the Worker script, not the container image). Migrations are never reversed, so a previous image must support the current schema; MySQL and R2 data are untouched.

## Migrations

Run migrations explicitly (`npm run migrate --workspace server`, or `server/dist/migrate.js` in the image); neither entrypoint applies DDL on startup.
Each file is split into single-object steps (`CREATE TABLE`, `CREATE INDEX`, or `ALTER TABLE ... ADD COLUMN` for one column) recorded in `schema_migrations` and `schema_migration_steps` under a per-schema named lock.
After an interruption, rerun the same command: finished steps are skipped, an object created before its ledger row is adopted, and an object created outside the ledger stops the run.
Never edit an applied migration (its checksum is verified), and never roll back by dropping tables.

## Sign-in

With the `SANCTUM_OIDC_*` group set, `/auth/login` signs a person in through any OIDC issuer (authorization code with `state`, `nonce` and PKCE), and `POST /auth/logout` revokes the browser session. Without the group, `/auth/login` answers `503`.
The verified issuer and subject select a principal through `principal_identities`; membership never comes from an email address.
Each successful sign-in with a non-empty ID token `name` claim replaces the principal's display name, including one set with `--display-name`, in the transaction that opens the session (plan sign-in section 5.2).
An unknown identity lands on `/?signin=not_member&issuer=…&subject=…`. On a fresh install, make that identity the first owner:

```bash
npm run owner -w server -- --issuer <iss> --subject <sub> --display-name "<name>" --workspace "<name>" --timezone <IANA>
```

It creates the workspace, principal, identity and `owner` membership in one transaction, and refuses while any workspace exists; `--workspace-id <id>` instead adds an owner to that workspace (`server/dist/owner.js` in the image).
A signed-in person binds a further issuer identity to themselves with `POST /auth/link`; a pair already bound to another principal is refused.

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

The sign-in issuer and MCP authorization server are decided (WorkOS AuthKit hosted, embedded Better Auth self-hosted). The hosted site is configured for WorkOS AuthKit ([Cloudflare](#cloudflare)); the embedded issuer is not built yet.
Saved-meeting retention and speech outside detected meetings remain open ([DECISIONS.md](DECISIONS.md)).
Until they are selected, production activation is refused and no recording expires automatically.
