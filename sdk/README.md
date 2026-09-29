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
- **Cancellation and timeouts.** TypeScript takes an `AbortSignal` per call; aborting stops the request and the server-side work. Python uses `timeout` (seconds, default 30) and task cancellation on `AsyncClient`.
- **Actions.** `requestAction` only records the request; execution needs a stored grant. `waitForAction` polls the receipt until `succeeded`, `failed`, `cancelled` or `unknown` (submitted but unreconciled; do not resubmit).
- **Revocation.** A revoked credential fails its next call with `unauthenticated`.

## Examples

```bash
SANCTUM_URL=https://sanctum.example SANCTUM_TOKEN=... node sdk/examples/typescript/context-workflow.ts <meeting_id>
SANCTUM_URL=https://sanctum.example SANCTUM_TOKEN=... PYTHONPATH=sdk/python/src python3 sdk/examples/python/context_workflow.py <meeting_id>
```

Each reads a meeting, cites a transcript segment, appends research, recovers from a conflict, consumes changes, requests an action and reads its receipt, then creates and revokes a read-only agent.

## MCP

Remote MCP clients connect to `/mcp` (Streamable HTTP, protocol baseline `2025-11-25`) with a delegated OAuth access token whose audience is the `/mcp` resource URL.
Discovery starts at `/.well-known/oauth-protected-resource/mcp`.
The authorization server is not selected yet (docs/DECISIONS.md); until `SANCTUM_MCP_RESOURCE`, `SANCTUM_MCP_ISSUER` and `SANCTUM_MCP_JWKS_URL` are configured, `/mcp` answers `503`.
A verified token's `sub` must map to one active workspace membership through `principal_identities`; its `scope` claim narrows that member's scopes.
