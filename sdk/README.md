# Sanctum SDKs

Both clients are generated from the v1 contract (`SanctumApi`) and call the same REST operations as the website and the MCP tools.
Run `npm run sdk:generate` after changing a contract; CI fails when `openapi.json`, `typescript/src/generated.ts` or `python/src/sanctum/_generated.py` is stale.
No package is published yet.

| Path | Contents |
| --- | --- |
| `openapi.json` | v1 OpenAPI 3.1 document, also served at `GET /api/v1/openapi.json`. Operation IDs are `group.endpoint`. |
| `typescript/` | Promise client over `fetch` (`createClient`, `pages`, `waitForAction`, `SanctumError`). |
| `python/` | Thin HTTPX client (`Client`, `AsyncClient`, `SanctumError`), Python 3.11+. |
| `examples/` | Runnable end-to-end workflows; tests run both against a server. |
| `fixtures/wire-cases.json` | Golden requests and responses both clients must reproduce. |

## Behavior

- **Authentication.** Pass an agent credential or delegated token; it is sent as `Authorization: Bearer`. Never put it in a URL.
- **Errors.** Every failure is a `SanctumError` with `status`, `code`, `retryable` and the full envelope in `body`. Missing and unauthorized resources both return `not_found`.
- **Retries.** Reads, and writes carrying an `idempotency_key`, retry up to `maxAttempts`/`max_attempts` (default 3) on network failure, `429` and `retryable` errors, waiting `retry_after_ms` when the server sends it and exponential backoff otherwise. Writes without a key are never retried.
- **Idempotency.** Repeating a write with the same key and payload returns the original result. The same key with different content fails with `hash_conflict`.
- **Conflicts.** A stale `expected_revision` fails with `revision_conflict` and `body.current_revision`. Re-read, rebase your change, and write again with a new key; never overwrite blindly.
- **Pagination.** Lists return `{ items, next_cursor }`. Pass `next_cursor` back as `cursor`; `pages()` does this until the cursor is null. Change cursors from `get_context`/`getContextChanges` are durable, so a consumer can resume from the last one it stored.
- **Searching context.** `searchContext` (MCP `search_context`) lists current items newest first by event time. All parameters are optional: `q` (in a keyword query every word of three or more characters must appear; a question (a `q` that contains a question or helper word such as `who`, `the`, `does`, `we`, `and`, `not` or a possessive `'s`) is grounded: up to 40 current items the caller may read, inside `meeting_id`, `kind`, `from` and `to`, that share a content word with it (best FULLTEXT match first) go to the configured `classifier` model (planner model on failure), which picks the items that answer the question; the stored text is sent as untrusted data, a pick outside the candidates or a model failure returns `unavailable` (503) instead of a word-match guess, and no answer returns no items. The picked items list newest first, so `Who owns onboarding now?` lists `Marcus takes over onboarding.` before `Priya owns onboarding.`; `next_cursor` continues the same picks for the same caller, query and permissions without asking the model again; a hyphenated word such as `off-site` also matches `off site` and `offsite`, and `offsite` also matches `off-site`), `meeting_id`, `kind` (`decision`, `commitment`, ...), `from` (inclusive) and `to` (exclusive) as UTC timestamps, `limit` (default 20, at most 200) and `cursor`. Without `q` it lists everything the caller may read that matches the other filters. The reply is `{ items, next_cursor }`; page with `pages(client, 'context.searchContext', { from, to })` (TypeScript) or `pages("context.searchContext", {...})` (Python). Callers that send only `q`, `meeting_id` and `limit` are unchanged apart from the extra `next_cursor` field.
- **Cancellation and timeouts.** TypeScript takes an `AbortSignal` per call; aborting stops the request and the server-side work. Python uses `timeout` (seconds, default 30) and task cancellation on `AsyncClient`.
- **Actions.** `requestAction` only records the request; execution needs a stored grant. An optional `title` names the request for people; the listening view's agent-work feed shows it. `waitForAction` polls the receipt until `succeeded`, `failed`, `cancelled` or `unknown` (submitted but unreconciled; do not resubmit).
- **Revocation.** A revoked credential fails its next call with `unauthenticated`.

## Examples

```bash
SANCTUM_URL=https://sanctum.example SANCTUM_TOKEN=... node sdk/examples/typescript/context-workflow.ts <meeting_id>
SANCTUM_URL=https://sanctum.example SANCTUM_TOKEN=... PYTHONPATH=sdk/python/src python3 sdk/examples/python/context_workflow.py <meeting_id>
```

Each reads a meeting, cites a transcript segment, appends research, recovers from a conflict, consumes changes, requests an action and reads its receipt, then creates and revokes a read-only agent.

## Querying the soak workspace

Any agent with a bearer token can read the soak meetings; the run and its pass bars are in [operations](../docs/operations.md#24-hour-soak).

| Need | Call | Notes |
| --- | --- | --- |
| Search by keyword or question | `GET /api/v1/context/search?q=launch+date` (TypeScript `client.context.searchContext({ q })`, Python `context.searchContext`) | Needs `context:read`. A keyword query needs every term of 3+ letters in one item. A question is answered by the configured model from at most 40 authorized word matches; it returns 503 when the model is unavailable. Newest first. |
| Time range or timeline | same route with `from`, `to`, `kind`; omit `q` to list the range | Page with `next_cursor` as `cursor`. Every item carries `event_at`; the latest fact wins by `event_at`, not by server supersession. |
| Meetings in a range | `GET /api/v1/meetings?from=&to=` | A detected meeting is private to its capturing principal until it is shared with the workspace (`POST /api/v1/meetings/{id}/share`). |
| Transcript and cited source | `GET /api/v1/meetings/{id}/transcript`, `GET /api/v1/sources/{id}` | Needs `recordings:read`. |
| Soak results | `GET /report.json` on the results page | Verdict per metric and checkpoint; no token. |

## MCP

Remote MCP clients connect to `/mcp` (Streamable HTTP, protocol baseline `2025-11-25`) with a delegated OAuth access token whose audience is the `/mcp` resource URL.
Discovery starts at `/.well-known/oauth-protected-resource/mcp`.
The authorization server is WorkOS AuthKit on the hosted site and embedded Better Auth when self-hosted (docs/DECISIONS.md); until `SANCTUM_MCP_RESOURCE`, `SANCTUM_MCP_ISSUER` and `SANCTUM_MCP_JWKS_URL` are configured, `/mcp` answers `503`.
A verified token's `sub` must map to one active workspace membership through `principal_identities`; the scopes it names narrow that member's scopes, and a token naming none gets `SANCTUM_MCP_DEFAULT_SCOPES` (see [operations](../docs/operations.md)).
