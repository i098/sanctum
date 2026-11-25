# sanctum-deploy-17: issue 252 evidence (Worker 0b6d4428, image sanctum-deploy17:3abde3c, digest sha256:a0bc8c61a963997380e1b6f818b3e4072b1298ba1c5fd43890aa3b43b55dc6af, commit 3abde3c)

Deployed proof: Worker version 0b6d4428-1829-4ee5-b727-f9b51b1e395e (2026-11-25T01:36:58Z). API a03e3a69 v29 and Jobs a03f86a7 v30 on the new image, one healthy instance each. /readyz 200 at 2026-11-25T02:01Z.

Test workspace: Hosted E2E check (951bf075-6e5f-4622-88ef-eaa6fe073958). Seat limit set by UPDATE on this workspace only; restored to NULL after each step.

| Run | Limit | Before (active seats) | Activations | Result | After (active seats) |
|---|---|---|---|---|---|
| Mailbox run 1 (disposable mailboxes, page code) | 2 | 1 | both callbacks held, then released | 200 + 401; 1 test user seated | 2 |
| Control (both users, limit NULL) | none | 1 | both callbacks held, then released | 200 + 200; 2 test users seated | 3 |
| Boundary: seated user (limit 2) | 2 | 1 | one sign-in | 200; seated | 2 |
| Boundary: third activation (fresh mailbox, page code) | 2 | 2 | one sign-in | 401 "No credentials" (signed out); no membership row, identity created | 2 |

Boundary third attempt, exact response: GET /api/v1/session -> HTTP 401 body `{"code":"unauthenticated","retryable":false,"message":"No credentials","_tag":"Unauthenticated"}`. Page: "Sign in to listen" (signed out).

Caveats: no run of the old build (28cafe4) was made on production. The concurrent race is proven by the TiDB test in PR 257, not by this deploy. Server log line `WorkOS member not added to Sanctum` could not be read from this host; the refusal is inferred from the missing membership row and the 2 active seats.

Cleanup: WorkOS users and org memberships for every test identity return 404 or are absent; org has the owner only. Mailboxes deleted (control mailboxes already gone). Final SELECT: seat_limit NULL, workspace_members owner only (1 active), 0 principal_identities with test subjects, 0 principals named sd17%.
