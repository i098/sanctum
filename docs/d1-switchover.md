# D1 standby and switch-over

Production runs on TiDB Cloud Starter (MySQL dialect). A Cloudflare D1 database (SQLite dialect) is a standby copy. Use it when the TiDB free quota ends.
The standby holds no application writes. A daily job copies TiDB into D1, in one direction only.

## What exists

| File | Purpose |
|---|---|
| `server/migrations-d1/0001_baseline.sql` | SQLite schema of the 38 application tables, in their state after `server/migrations/001` to `024`. It also has `tx_clock`, `tx_conflict` and the FTS5 table `context_items_fts` with its triggers. The embedded issuer's `auth_*` tables are not in it. |
| `scripts/d1-sync.ts` | `snapshot` reads TiDB and writes SQL that replaces the D1 rows. `verify` compares row counts and checksums of TiDB and D1. |
| `.github/workflows/d1-sync.yml` | Runs both daily at 03:17 UTC and on demand. |
| `deploy/d1/wrangler.jsonc` | Names the database `sanctum` for `wrangler d1` commands. It deploys no Worker. |

Every new MySQL migration needs a matching change in a new `server/migrations-d1/NNNN_*.sql`. `tests/d1-schema-parity.test.ts` fails when a table or column name differs.

## Operator prerequisites

No D1 database and no secret exist yet. The workflow skips with a notice that names the missing secrets, so `main` stays green.

1. Create the database: `npx wrangler d1 create sanctum`.
2. Add these repository secrets:
   - `D1_SYNC_MYSQL_URL`: `mysql://user:password@host:4000/database` for a TiDB user that can only read.
   - `D1_DATABASE_ID`: the id that `d1 create` printed.
   - `CLOUDFLARE_API_TOKEN`: a token with D1 edit permission.
   - `CLOUDFLARE_ACCOUNT_ID`.
3. Run the workflow by hand once and read the verify step.

## How a run works

1. `wrangler d1 migrations apply sanctum --remote` applies the baseline.
2. `snapshot` reads every table from TiDB in foreign-key order and writes `snapshot.sql`: `DELETE` for each table, chunked `INSERT` statements below 90 KB each, an FTS5 `rebuild`, and the triggers dropped and created again around the load.
3. `wrangler d1 execute --file` loads the file.
4. `verify` reads both sides and compares a row count and a SHA-256 checksum for each table. A difference makes the run fail and names the tables.

## Limits

- A single row above 90 KB as SQL text fails the snapshot, because D1 refuses statements above 100 KB. The error names the table.
- The standby is at most 24 hours old. Writes after the last run, and the `auth_*` tables, are not in D1.
- A failed load can leave D1 partly filled `[INFERENCE: file import is not documented as atomic]`. Run the workflow again.
- D1 counts rows read and written. A daily full snapshot stays inside the included monthly usage up to about 1.6 million rows. Above that, change to an incremental sync.
- `verify` reads integers through JSON, so values above 2^53 can differ on the D1 side.
- Behavior differences between the two dialects are listed in the D1 port plan (timestamps with millisecond precision, FTS5 prefix search, case-sensitive text except `provider_label`).

## Switch-over

Do this when TiDB Request Units reach 80 % of the monthly quota, or when the owner orders it. After the first D1 write, a rollback loses data.

1. Merge `main` into `feat/d1-store` and wait for green CI.
2. Make the TiDB application user read-only. A write through the app must return an error and reads must work.
3. Run `d1-sync` by hand. The verify step must pass.
4. Merge `feat/d1-store` to `main`, apply the migrations with `wrangler d1 migrations apply sanctum --remote`, then deploy from `deploy/cloudflare`.
5. Check `https://app.sanctum.42nights.dev/readyz` and open a meeting made before the freeze.
6. Delete `server/migrations`, `scripts/d1-sync.ts`, `deploy/d1`, `d1-sync.yml` and the parity and sync tests.

Rollback before the first D1 write: `wrangler rollback`, then give the TiDB user its write right again.
