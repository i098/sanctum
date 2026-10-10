# Operations

How to run, check and recover Sanctum.
Nothing here authorizes a new deployment, a production migration, paid services or live recording; those need their own approval (see [DECISIONS.md](DECISIONS.md)).

## Processes

Base images (`node`, `mysql`, `caddy`) come from the Docker Hub library mirror at `public.ecr.aws/docker/library/` with unchanged tags, because anonymous Docker Hub pulls hit its rate limit on shared CI runners.

One Node image serves two entrypoints ([server/Dockerfile](../server/Dockerfile), [docker-compose.yml](../docker-compose.yml), [Cloudflare](#cloudflare)):

- `api` (`server/src/main.ts`): `/api/v1`, `/mcp`, the listener WebSocket upgrade, the built website and, when [self-hosted sign-in](#self-hosted-sign-in) is on, the embedded issuer at `/idp`, all on one port behind Caddy.
- `worker` (`server/src/worker.ts`): the durable MySQL job ledger (notes, recording assembly, transcript reconciliation, speakers, context, memory, matching, actions, WorkOS organization sync, workspace purge).

Both refuse to start in `SANCTUM_ENV=production` until every decision is listed in `SANCTUM_SELECTED_DECISIONS` (`identity_issuer`, `mcp_authorization_server`, `meeting_retention`, `outside_meeting_speech`).
In every environment, both refuse to start when a listed decision lacks its settings, and the error names each missing variable: `identity_issuer` needs `SANCTUM_OIDC_ISSUER`, `SANCTUM_OIDC_CLIENT_ID` and `SANCTUM_OIDC_REDIRECT_URI` (plus `BETTER_AUTH_SECRET` with the embedded issuer); `mcp_authorization_server` needs the three `SANCTUM_MCP_*` URLs.
The worker also refuses to start while migrations are pending; `/readyz` reports pending migrations as not ready.

## Configuration

Secrets come from the environment only; none are committed.

| Group | Variables |
| --- | --- |
| Core | `SANCTUM_ENV`, `SANCTUM_SELECTED_DECISIONS`, `API_PORT`, `SANCTUM_ALLOWED_ORIGINS`, `SANCTUM_WORKSPACE_PURGE_GRACE_DAYS` (days from a workspace deletion to its purge, default 7, at least 1) |
| Workspaces | `SANCTUM_DEFAULT_SEAT_LIMIT`: owner, admin and member seats per workspace; a positive integer, unset for no limit (the hosted Worker sets `5` in `deploy/cloudflare/wrangler.jsonc`). A workspace's own `workspaces.seat_limit` overrides it (operator SQL; NULL uses the default). A malformed value stops startup. A member beyond the limit is refused with `SeatLimitReached`; existing members stay. |
| Organizations (hosted) | `WORKOS_API_KEY` (server-only WorkOS API key; with `SANCTUM_OIDC_ISSUER` set to the AuthKit issuer, it turns on [WorkOS organization sync](#workos-organizations)), `SANCTUM_SELF_SERVE_WORKSPACES` (`true` lets a signed-in person with no membership create a workspace; default `false`; needs `WORKOS_API_KEY`) |
| MySQL | `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_POOL_SIZE`, `MYSQL_POOL_QUEUE`, `MYSQL_CA_CERT` (PEM text; when set, TLS is required and the server certificate and host name are verified) |
| Recordings (R2) | `R2_ENDPOINT`, `R2_BUCKET`, `R2_PREFIX`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_TIMEOUT_MS` |
| Speech | Requested output shares the Workers AI credentials in the Models row; see the [speech output decision](DECISIONS.md#speech-output-decision---2026-10-10). Optional diarization uses `PYANNOTE_API_KEY`. |
| Models | `WORKERS_AI_ACCOUNT_ID`, `WORKERS_AI_API_TOKEN` (server-only token with Workers AI permission, shared by Whisper, Aura-2, voice, extraction and planner), `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (server-only; pays for web research only, through the Responses API `web_search` tool), `<ROLE>_MODEL_PROVIDER` (`workers-ai` or `anthropic`; research: `openai` or `anthropic`), `<ROLE>_MODEL` for voice, extraction, planner, research, `SANCTUM_PAID_RESEARCH_CALLS_PER_DAY` (paid web-research calls each workspace may start per UTC day, default 2), `SANCTUM_PAID_RESEARCH_CALLS_PER_DAY_TOTAL` (paid web-research calls all workspaces together may start per UTC day, default 4); `0` turns paid calls off, and each call is reserved in `paid_model_calls` before it is sent and records the provider's token usage |
| Integrations | `PIPEDREAM_API_URL`, `PIPEDREAM_ENVIRONMENT`, `PIPEDREAM_PROJECT_ID`, `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET` |
| Sign-in | `SANCTUM_OIDC_ISSUER` (exact ID token `iss`; discovery at `/.well-known/openid-configuration` under it), `SANCTUM_OIDC_CLIENT_ID`, `SANCTUM_OIDC_REDIRECT_URI` (`https://<host>/auth/callback`); sign-in is enabled only when all three are set, otherwise `/auth/login` answers `503`; `SANCTUM_OIDC_CLIENT_SECRET` (omit for a public client, which uses PKCE), `SANCTUM_OIDC_SCOPES` (default `openid profile email`), `SANCTUM_EMBEDDED_ISSUER` (`better-auth` serves the self-hosted issuer at `/idp`; reported by `GET /auth/config`), `BETTER_AUTH_SECRET` (at least 32 characters, needed when the embedded issuer is selected) |
| Remote MCP | `SANCTUM_MCP_ISSUER`, `SANCTUM_MCP_JWKS_URL`, `SANCTUM_MCP_RESOURCE`, `SANCTUM_MCP_DEFAULT_SCOPES` (comma list granted only to tokens that name no Sanctum scope, such as WorkOS DCR/CIMD clients; always narrowed by role and never `workspace:admin` or `capture:ingest`; empty by default; when set, metadata and challenges stop naming scopes) |

WorkOS AuthKit (hosted) and embedded Better Auth (self-hosted) both use one value for `SANCTUM_OIDC_ISSUER` and `SANCTUM_MCP_ISSUER`; when the two differ, an identity linked at login does not authorize MCP.
The sign-in routes read the Sign-in group; a partial `SANCTUM_OIDC_*` set does not stop startup unless `identity_issuer` is listed, and sign-in then stays off.
With `SANCTUM_EMBEDDED_ISSUER` set, the embedded issuer reads `SANCTUM_OIDC_ISSUER`, `SANCTUM_MCP_RESOURCE` and `BETTER_AUTH_SECRET`, and `/mcp` reads the `SANCTUM_MCP_*` settings; `issuer:client` also reads `SANCTUM_OIDC_REDIRECT_URI`.

A missing provider key never falls back to another provider or to invented output: the affected call fails as `Unavailable`, jobs record the failure, and no audio is spoken.
See the [spoken work decision](DECISIONS.md#spoken-work-decision---2026-10-10) for the trigger prerequisites.
With `PLANNER_MODEL_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` set, the planner defaults to `claude-sonnet-5-5`.
An explicit `<ROLE>_MODEL` stays unchanged; otherwise the selected provider supplies the default for each role.
See the [planner provider decision](DECISIONS.md#planner-provider-decision---2026-10-10) for malformed output and the research boundary.
Paid web research is capped by those two daily allowances and by `researchMaxSearches` (3 web searches per call) in `engineeringDefaults`; a spent allowance refuses the call before anything is sent and the job result says so.
Worst case with the defaults: 4 calls a day is about 120 calls a month. At GPT-4.1-mini prices one call costs at most about USD 0.046 (3 searches at USD 0.01, 24,000 search-content input tokens at USD 0.40 per million, 4,096 output tokens at USD 1.60 per million), plus its short prompt, so about USD 5.50 a month at most.
Engineering defaults (chunk length, heartbeat and lease, context debounce, playback URL lifetime, meeting idle close) live in `engineeringDefaults` in [server/src/config.ts](../server/src/config.ts).
The worker sweeper closes an open meeting after `meetingIdleCloseMs` (default 10 minutes) with no speech when ASR finished that much audio past the last speech, or when its listener is paused or stopped for that long with nothing left to transcribe or upload; it never closes while ASR or upload lags. The close is the same as `POST /api/v1/meetings/{id}/close` and survives worker restarts, because the sweep reads only MySQL ([DECISIONS.md](DECISIONS.md#meeting-end-decision--2026-10-09)).

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
It uses the existing MySQL through its own two-connection pool and the `auth_*` tables of migrations `011_embedded_issuer` and `013_issuer_organizations`; run migrations first. Sanctum never runs Better Auth's own migrator.

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
- **Team**: the team of a workspace is a Better Auth organization with the workspace's id and name ([server/src/issuer-orgs.ts](../server/src/issuer-orgs.ts)). An owner sets it up in Settings → Workspace → Team. Then owners and admins invite people (email and role), change roles and remove members there; members see the list. Each change goes to `workspace_members`: an accepted invitation creates the human principal and its identity, and a removal revokes the membership before Better Auth deletes it, so the person's sessions and MCP tokens stop at once. Each sign-in applies the person's organization roles again, which repairs an addition or role change whose Sanctum side failed. A workspace at its seat limit refuses the invitation before Better Auth adds the member. Leaving an organization and deleting one are off; a workspace is deleted in Sanctum.
- **Invitation links**: Sanctum has no email transport, so the inviter copies the link `https://<host>/invite/<id>` (valid for 48 hours) and sends it. Sign-up is open and email is not verified, so the invitation id in the link is the secret: whoever holds the link and registers the invited email address can accept. Only owners and admins see pending invitations (members get an empty list from `get-full-organization`; the issuer refuses `/organization/list-invitations` and `/organization/list-user-invitations`), and no invitation carries `owner`: an owner makes another owner by changing a member's role. Give the link only to the invited person. When SMTP exists, send invitations by email and set `requireEmailVerificationOnInvitation: true` for the organization plugin in issuer.ts.
- **Members outside the team**: an owner added with `npm run owner -w server -- --workspace-id <id>` keeps access but is not in the team list until someone invites them. Joining by invitation, and each later sign-in, never lower an existing Sanctum owner: the person stays `owner`, and the organization role is set to `owner` too, whatever role the invitation named. A role change or removal an owner makes in Team always applies, demotion included. Where the workspace already has a team, Team tells a person outside it to ask an owner for an invitation.
- **Profile**: Settings → Profile changes the display name and the password at the issuer; Sanctum shows the new name after the next sign-in.
- **MCP workspace**: an MCP access token carries `org_id`, the active organization of the browser session that authorized it (opening Team or accepting an invitation sets it), so `/mcp` selects that workspace.
- **Upgrades**: Better Auth versions are pinned. At startup it logs any difference between its expected schema and the database; an upgrade that needs more than new tables, indexes or columns is its own reviewed task.

## Cloudflare

The deployed instance runs in the 42nights Cloudflare account from [deploy/cloudflare](../deploy/cloudflare): Worker `sanctum`, Container applications for `SanctumApi` and `SanctumJobs` (same image, one instance each), MySQL on Aiven over verified TLS (database `sanctum`), recordings in the private R2 bucket `sanctum-recordings`.
It serves two Workers custom domains declared in `wrangler.jsonc`: `https://app.sanctum.42nights.dev` (the app, `/api/v1`, `/mcp`, `/.well-known/*`, `/auth/*`, `/invite/*`) and the apex `https://sanctum.42nights.dev`; `workers_dev` is off.
On deploy, Cloudflare creates the DNS record and certificate for each custom domain in the `42nights.dev` zone; no DNS record is added by hand.

- **Routing**: on the app host the Worker sends every request, including the listener WebSocket, to the API container. On the apex it serves `GET` and `HEAD` for the static landing page ([web-app/landing](../web-app/landing), Workers static assets bound as `LANDING`) with its own CSP and answers every other request with `308` to the same path and query on the app host, so old links and bookmarks keep working; existing MCP clients follow the redirect but must authorize again, because their tokens carry the old resource as audience ([index.ts](../deploy/cloudflare/src/index.ts)). Session cookies are host-only, so a session from the apex does not carry over and the person signs in again on the app host. Anyone without a session reaches the app signed out and signs in through WorkOS. The Worker forwards only the settings listed in [settings.ts](../deploy/cloudflare/src/settings.ts).
- **Sign-in and MCP authorization**: WorkOS AuthKit in the WorkOS production environment, AuthKit domain `merry-precipice-00.authkit.app`. The `SANCTUM_OIDC_*`, `SANCTUM_MCP_*` and `SANCTUM_SELECTED_DECISIONS` values are `vars` in [wrangler.jsonc](../deploy/cloudflare/wrangler.jsonc); `SANCTUM_OIDC_CLIENT_SECRET` is a Worker secret. The WorkOS dashboard (or the WorkOS API) must have:
  - a first-party Connect OAuth application (Connect → Applications) with the redirect URI `https://app.sanctum.42nights.dev/auth/callback`, PKCE off, and a client secret; its client ID is `SANCTUM_OIDC_CLIENT_ID`;
  - Dynamic Client Registration and Client ID Metadata Document both enabled (Connect → Configuration → MCP Auth);
  - the resource indicator `https://app.sanctum.42nights.dev/mcp`, set as the default (Connect → Configuration → MCP resource indicators);
  - sign-up enabled (Authentication → Features) and at least one sign-in method, here Magic Auth (Authentication → Methods);
  - a payment method on the WorkOS team, because the production environment needs one (no charge under 1M monthly active users).
  WorkOS lists `registration_endpoint` and `client_id_metadata_document_supported` only in `/.well-known/oauth-authorization-server`, not in `/.well-known/openid-configuration`.
- **Job worker**: has no port and is never stopped for inactivity; a cron every five minutes starts it again after a crash or rollout. State lives in MySQL and R2; container disk is disposable.
- **Mode**: `SANCTUM_ENV=development` (production refuses to start while decisions are open). Provider requirements are listed under [Configuration](#configuration).
- **Deploy** (Docker must be usable by the deploying user, or set `WRANGLER_DOCKER_BIN` to a wrapper): from `deploy/cloudflare`, `npx wrangler deploy`. Wrangler first builds the landing page (`npm run build:landing` in `web-app`, the `build` command in `wrangler.jsonc`, which runs relative to this directory), then builds `server/Dockerfile`, pushes it to the account registry and rolls out both containers.
- **Settings changes**: a running container keeps the environment it started with, and Cloudflare cannot restart it from outside. Each container records a SHA-256 hash of its start environment (no values). After a deploy or `wrangler secret put` changes a forwarded setting, the next request (the API) or cron start (the job worker) records the new hash, then stops the old container and starts it with the current settings. Each hash allows one restart attempt, so a stop that fails cannot loop. Requests wait during the restart, and an open listener reconnects and resumes.
- **Secrets** (`npx wrangler secret put NAME`, read from stdin): `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_CA_CERT` (the provider's project CA, PEM).
  R2 uses `R2_ENDPOINT`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, limited to the private bucket.
  Sign-in uses `SANCTUM_OIDC_CLIENT_SECRET` for the WorkOS OAuth application.
  Set the provider credentials listed under [Configuration](#configuration).
  Optional keys: `ANTHROPIC_API_KEY` (explicit Anthropic model overrides), `OPENAI_API_KEY` (web research only; paid; bounded by `SANCTUM_PAID_RESEARCH_CALLS_PER_DAY`), `PIPEDREAM_PROJECT_ID`, `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET` (actions), `PYANNOTE_API_KEY` with `SANCTUM_DIARIZATION=pyannote` (diarization), `WORKOS_API_KEY` (organization sync).
  Non-secret settings, including `WORKERS_AI_ACCOUNT_ID` and `SANCTUM_SELF_SERVE_WORKSPACES`, are `vars` in [wrangler.jsonc](../deploy/cloudflare/wrangler.jsonc).
  The Worker forwards only [listed settings](../deploy/cloudflare/src/settings.ts), including model choices; an unset setting keeps the application default.
- **Migrate** before deploying a new schema, with the image's own entrypoint and the CA mounted read-only: `docker run --rm --env-file <(...) -v "$CA:/ca.pem:ro" <image> sh -c 'MYSQL_CA_CERT="$(cat /ca.pem)" exec node server/dist/migrate.js'`, where the env file holds the same `MYSQL_*` values. The job worker refuses to start while migrations are pending.
- **Logs**: `npx wrangler tail sanctum` for the Worker; container stdout and stderr appear in the dashboard under Workers & Pages → `sanctum` → Containers, and in Workers observability. Workers invocation logs are off (`observability.logs.invocation_logs`) because they record the full request URL, which would store the one-time authorization code in `/auth/callback?code=…`; `wrangler tail` still shows live request URLs.
- **Rollback**: check out the previous validated commit and `npx wrangler deploy` from it; that rebuilds its image and rolls both containers back with the Worker (`wrangler rollback` alone reverts only the Worker script, not the container image). Migrations are never reversed, so a previous image must support the current schema; MySQL and R2 data are untouched.

## Migrations

Run migrations explicitly (`npm run migrate --workspace server`, or `server/dist/migrate.js` in the image); neither entrypoint applies DDL on startup.
Each file is split into single-object steps (`CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE ... ADD COLUMN` for one column, `ALTER TABLE ... MODIFY COLUMN`, or an idempotent `UPDATE` backfill that reruns until recorded) recorded in `schema_migrations` and `schema_migration_steps` under a per-schema named lock.
After an interruption, rerun the same command: finished steps are skipped, an object created before its ledger row is adopted, and an object created outside the ledger stops the run.
Never edit an applied migration (its checksum is verified), and never roll back by dropping tables.

## Sign-in

With the `SANCTUM_OIDC_*` group set, `/auth/login` signs a person in through any OIDC issuer (authorization code with `state`, `nonce` and PKCE), and `POST /auth/logout` revokes the browser session. Without the group, `/auth/login` answers `503`.
The verified issuer and subject select a principal through `principal_identities`; membership never comes from an email address.
Each successful sign-in with a non-empty ID token `name` claim replaces the principal's display name, including one set with `--display-name`, in the transaction that opens the session (plan sign-in section 5.2).
A non-empty `email` claim refreshes `principals.email` in the same transaction; only the principal's own session (`GET /api/v1/session`) and Settings show it. A token without the claim keeps the stored value. With no name claim, `given_name` and `family_name` are used; with none of them (but an email) `principals.display_name` becomes NULL, so a seeded placeholder such as `Owner` never leads and Settings shows the email. The email is never copied into display names or audit text.
An unknown identity lands on `/?signin=not_member&issuer=…&subject=…`. On a fresh install, make that identity the first owner:

```bash
npm run owner -w server -- --issuer <iss> --subject <sub> --display-name "<name>" --workspace "<name>" --timezone <IANA>
```

It creates the workspace, principal, identity and `owner` membership in one transaction, and refuses while a workspace that is not deleted exists (a deleted workspace, during its grace period or after its purge, does not block a new one; an identity whose principal still exists because its deleted workspace is not purged yet is reused, not duplicated); `--workspace-id <id>` instead adds an owner to that workspace, and refuses a deleted workspace with its deletion and purge time (`server/dist/owner.js` in the image).
A signed-in person binds a further issuer identity to themselves with `POST /auth/link`; a pair already bound to another principal is refused.

### WorkOS organizations

On the hosted site, WorkOS is the source of workspace members ([server/src/org-sync.ts](../server/src/org-sync.ts)); it is on when `WORKOS_API_KEY` and `SANCTUM_OIDC_ISSUER` are set.
A WorkOS organization linked in `workspace_orgs` is a workspace; Sanctum's `workspace_members` stays the only input to authorization, and an unlinked workspace is never changed until its owner links it (Set up team below).
Roles map `owner` to `owner`, `admin` to `admin`, and any other role slug to `member`; an `inactive` or `pending` membership counts as removed.
Sync revokes only a membership that WorkOS granted (`workspace_members.org_issuer` is the AuthKit issuer; migration `016_member_org_issuer` marks the active members of already linked workspaces as granted). A member that Sanctum added, for example before the workspace was linked, keeps access until WorkOS grants it and then removes it.

- **Sign-in**: each AuthKit sign-in reads the person's WorkOS memberships. A membership in a linked organization adds or updates the Sanctum member (first creating the human principal and identity), and a WorkOS-granted membership that WorkOS no longer lists as active is revoked. An accepted WorkOS invitation therefore becomes a member at the first sign-in. A WorkOS error ends the sign-in at `/?signin=failed`.
- **Events**: the worker job `workos.sync` reads `organization_membership.created/updated/deleted`, `organization.deleted` and `user.deleted` from the WorkOS Events API every minute (`engineeringDefaults.workosSync`), resuming after the event id in `sync_cursors` (`workos.events`). A removal revokes a WorkOS-granted member at once, so sessions and MCP tokens stop. An identity that never signed in is skipped; its first sign-in adds it. `organization.deleted` only deletes the `workspace_orgs` row; the workspace, members and recordings stay. The job runs under the oldest workspace (ledger rows belong to a workspace), re-arms itself before each run, and is scheduled when the worker starts.
- **Self-serve**: with `SANCTUM_SELF_SERVE_WORKSPACES=true`, the `not_member` notice in Settings offers **Create workspace** (name and timezone). It signs in again through `/auth/login?workspace_name=…&timezone=…`; when the person still has no membership, Sanctum creates the WorkOS organization (`external_id` `sanctum-self-serve:<WorkOS user id>`), the WorkOS `owner` membership, the workspace (with the default seat limit) and its link, then adds the owner from WorkOS. Each step is skipped when done, so a retry after a failure creates nothing twice. The WorkOS `owner` membership is created only while the organization has no link, so an owner removed at WorkOS is never re-added. Seats above the limit are refused at sync and logged; the person stays in the WorkOS organization.
- **WorkOS environment roles** (dashboard, per environment; the hosted site uses production and development uses staging only): add the role `owner` with the permission `widgets:users-table:manage`; the seeded `admin` (all widget permissions) and default `member` stay. Self-serve fails at the membership step without the `owner` role. No JWT template is needed (roles come from the API). Keep domain-based JIT membership off, because membership never comes from an email domain.
- **Team (website)**: on a server with WorkOS organizations, Settings shows **Team** on the Workspace row to owners and admins of a linked workspace. It opens the WorkOS User Profile and Users Management widgets (invite, remove and change the role of members; edit your own profile), loaded only on first use. The website gets a one-hour widget token from `POST /api/v1/workspace/widget-token` (session plus `x-csrf-token`, `workspace:admin`) for the caller's WorkOS user and the organization linked to the workspace; the server neither logs nor stores it. A caller without a WorkOS identity, or a workspace without a linked organization, gets `404` with the reason; a member gets `403`. Changes made in the widgets reach Sanctum through the sign-in and events sync above.
- **Set up team (website)**: an existing workspace created before WorkOS has no link, so Settings shows **Team** only to its owner, with **Set up team**. That calls `POST /api/v1/workspace/team` (session plus `x-csrf-token`, `workspace:admin`, owner role; `GET` on the same path tells owners and admins whether the workspace is linked). It creates the WorkOS organization (the workspace name, `external_id` `sanctum-workspace:<workspace id>`), then the WorkOS `owner` membership for the owner's WorkOS user, then the link, and Team then loads the widgets. Each step is skipped when it is already done, so a retry creates nothing twice. An owner without a WorkOS identity gets `404` asking them to use Connect sign-in first; an admin gets `403`; a server without WorkOS organizations answers `503`. Other members are not pushed to WorkOS: invite them from Team. Until they accept and sign in, their existing Sanctum membership stays as it is, also across their own AuthKit sign-ins and the events sync.
- **Allowed web origin** (dashboard, per environment): the widgets call `https://api.workos.com` from the browser, so add the site origin (`https://app.sanctum.42nights.dev` for the hosted site) under Applications → your application → Sessions → CORS. Without it, Team shows the widgets' error instead of the members. The page CSP already allows `connect-src https://api.workos.com`, and `style-src` allows the widgets' three fixed `<style>` elements by hash ([server/src/web.ts](../server/src/web.ts); regenerate them on a widgets or Radix upgrade).

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
- **Workspace deleted by mistake**: an owner signs in again and chooses Undo in Settings (`POST /api/v1/workspace/restore`) before the purge time shown there; a deleted workspace admits only an owner, for sign-in, the status read and Undo, until that time, and every other request, member, agent credential and background job is refused. After Undo every member, session and agent credential works again, and jobs that failed only because the deletion refused their requester (recording assembly, notes, memory) run again. Queued agent actions the executor cancelled during the deletion stay cancelled; request them again. After the purge time the `workspace.purge` job deletes the R2 objects under `workspaces/<id>/` and `meetings/<id>/`, then the rows, and writes its receipt to the job's `result`; nothing can be restored, and not even an owner can sign in. Only an owner's deletion starts a purge.
- **Capture open during a deletion**: the API process that holds a listener socket sends the client a `rejected` message with reason `unauthorized` (the web app then shows signed out) and closes it with code 1008; the web app pauses capture and releases the microphone after its own delete. An API process other than the one that served the delete keeps its socket open, but every segment, chunk commit and recording-object write for the deleted workspace is refused, so nothing more is stored. Audio already uploaded stays until the purge.
- **Purge interrupted**: object deletes are idempotent and the rows go in one transaction, so the next attempt continues where the last stopped; a rerun after the rows are gone returns the stored receipt. A retryable error (R2 outage, unconfigured store) retries at the capped backoff of 5 minutes without an attempt limit.
- **Connected accounts after a workspace deletion**: the purge deletes the `integration_accounts` rows but never calls Pipedream, so the OAuth connections stay authorized there. Before the purge time, list them with `SELECT external_user_id, provider_account_id, app_slug FROM integration_accounts WHERE workspace_id = '<id>' AND status = 'active'`, then remove each in Pipedream. After the purge no Sanctum row remains to list them from.
- **Purge job failed**: only a non-retryable error ends it, such as an invalid payload. After fixing the cause, requeue it: `UPDATE jobs SET status = 'pending', attempts = 0, available_at = UTC_TIMESTAMP(6), lease_token = NULL, lease_until = NULL WHERE kind = 'workspace.purge' AND status = 'failed' AND workspace_id = '<id>'`.
- **Rollback**: set `SANCTUM_IMAGE` to the previous validated tag and `docker compose up -d api worker`; data volumes and R2 objects are untouched and migrations are never reversed, so a previous image must support the current schema.

## Not yet selected

The sign-in issuer and MCP authorization server are decided (WorkOS AuthKit hosted, embedded Better Auth self-hosted). The hosted site is configured for WorkOS AuthKit ([Cloudflare](#cloudflare)); the embedded issuer is built ([Self-hosted sign-in](#self-hosted-sign-in)) but runs in no deployment.
Saved-meeting retention and speech outside detected meetings remain open ([DECISIONS.md](DECISIONS.md)).
Until they are selected, production activation is refused and no recording expires automatically (only an owner's workspace deletion purges data).
