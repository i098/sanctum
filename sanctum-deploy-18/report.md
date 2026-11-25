# sanctum-deploy-18: deploy of main 00890dc, issue 256 budget test

## Rollback target
- Production before this task: commit `3abde3c`, Worker `0b6d4428-1829-4ee5-b727-f9b51b1e395e` (100%, `npx wrangler deployments status`, read at 02:18Z, 2026-11-25).
- Migrations: none. `git diff --name-only 3abde3c 00890dc` lists `changelog.d/256.fixed.md`, `server/src/executor.ts`, `server/tests/actions.test.ts`.
- Rollback was not needed.

## Deployed
- Commit `00890dc` (merge of #258). Image `sanctum-deploy18:00890dc`, id `bba4d2642af8`, digest `sha256:bba4d2642af8d1eb4763cddfd7fba15104fa6313c80faafe5f130a917faf9052`.
- Build: `docker build -f server/Dockerfile` on the shared daemon, no timeout. Attempt 1 started 03:22:11Z, `BUILD_OK` after about 60 min. Log: `build-tail.log`.
- Docker access: this user is not in group `docker`. Builds used `/tmp/sd18/docker-sudo` (`sudo -n /usr/bin/docker`) against the existing daemon. No daemon was started. No network device changed.
- Load gate: the first gated loop waited on load (116–153). Second mate changed the gate (inbox 002); the build then ran with no load check.
- Push: `registry.cloudflare.com/2c040ec5bc2efe34e60ab5b1b4fd2e99/sanctum-deploy18:00890dc` via `WRANGLER_DOCKER_BIN=/tmp/sd18/docker-sudo npx wrangler containers push`.
- Deploy: `npx wrangler deploy --config wrangler.deploy18.jsonc` (temporary config, image line replaced; deleted after). Exit 0.
- Worker version `58cf7f1e-0e95-4eda-b042-4dd56a56c6c7`, created 2026-11-25T04:24:26Z, 100%.
- Containers: API `a03e3a69-df0c-4ea6-a7f4-48b4ab4ea8a4` ready. Jobs `a03f86a7-1587-43a8-9eb3-ea900b16ccf9` ready, version 31, `healthy: 1`, image `sanctum-deploy18:00890dc`, after about 1 min in `provisioning`.
- `GET https://app.sanctum.42nights.dev/readyz` = 200.

## Issue 256: before and after
Test workspace `951bf075-6e5f-4622-88ef-eaa6fe073958`. Budget is the constant `engineeringDefaults.actionBudget` = 30 started actions per 60000 ms (`server/src/config.ts:20`). It is not a workspace setting, so nothing was changed or restored.
Setup (synthetic rows, workspace-only): 1 integration account `sd18-fake-<uuid>` (status active, fake provider id), 1 grant (`sd18_fake_noop`, version 1), N actions with state `succeeded` and `started_at` = now (the window fill), then 1 queued test action plus 1 `action.execute` job row. The fill rows and the job were inserted in one transaction. Source: `/tmp/sd18/budget.mjs`.

Counts (`a`=accounts, `g`=grants, `x`=actions, `j`=jobs, `w`=actions started in last 60 s):
| Step | a | g | x | j | w |
|---|---|---|---|---|---|
| Before (pre counts) | 0 | 0 | 0 | 41 | 0 |
| Boundary, before submit (30 fills) | 1 | 1 | 31 | 42 | 30 |
| Boundary, after | 1 | 1 | 31 | 42 | 30 |
| Control, before submit (29 fills + the 30-fill run's cleanup) | 2 | 2 | 61 | 43 | 59 |
| Control, after | 2 | 2 | 61 | 43 | 30 |
| After cleanup | 0 | 0 | 0 | 41 | 0 |

The control `w` before submit reads 59 because the boundary's own fill rows were still inside the window. The control count of 30 after the run is the 29 fills plus the control action itself.

Boundary (over budget, 30 of 30 used):
- Job `807d2cb5-a9da-4116-b188-d7b8ff242437`: `status=paused`, `available_at` +~60 s, `last_error = {"message":"Action budget of 30 per 60000 ms reached","retryable":true}`.
- Action `cbb4c51d-1d47-429c-9c25-25f14e4f7a72`: `state=queued`, `attempts=0`, `started_at=null`, `last_error=null`. No provider call.
- Result: PAUSED before any provider call. Pass.

Control (29 of 30 used, budget left):
- Action `97002789-03d0-44b0-a7d0-ba0a0c378d5f`: `attempts=1`, `started_at` set, `state=failed`, `last_error = {"code":"provider_failed","message":"Integration action changed since it was inspected; inspect it again"}`.
- Job status `succeeded` (`result.state = failed`).
- Result: passed the budget check and reached the provider step. The fake account failed there, as expected.

Both test rows: the job of the boundary was cancelled by the script before its retry time (`UPDATE jobs SET status='cancelled'` and the action set to `cancelled`), then all rows were deleted.

Cleanup proof (read-only SELECT counts after the run, workspace `951bf075`): 0 integration accounts, 0 grants, 0 actions, 41 jobs (same as before). The test rows were deleted by ID in `finally`. Other workspaces were not read or written.

## PR 258 race test on TiDB (commit 00890dc)
- Command: `npx vitest run tests/actions.test.ts -t "pauses when another execution fills"` in `server/`, with `SANCTUM_TEST_MYSQL_URL` pointing at TiDB, `SANCTUM_TEST_MYSQL_CA_CERT` = `/etc/ssl/certs/ISRG_Root_X1.pem`, per-suite throwaway database `sanctum_t_*` (dropped).
- Result: `✓ pauses when another execution fills the action budget after the snapshot 58517ms`, `Tests 1 passed | 11 skipped`. Log: `tidb-race-test.log`.
- Note: the test name changed in `59d6385` (review fix). The earlier name `concurrent executions cannot overshoot…` (ffaa326) no longer exists.

## Issues found
- Docker group membership is missing for this user. The build worked through `sudo -n`, which needs passwordless sudo. Recommend adding the deploy user to `docker` or documenting the wrapper.
- The `actions.test.ts` file in `00890dc` runs the race test against TiDB, but the full file took more than 8 minutes on TiDB (each statement crosses the network). Not a failure.

## Status
- Deploy: live and healthy.
- Issue 256: boundary PAUSED on the live image; race test passes on TiDB at 00890dc. See the status line below for the close.
