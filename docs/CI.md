# CI/CD

## Current scope

The pipeline validates and publishes the documentation and visual reference that exist today.
The Application checks job tests the application workspaces implemented so far.
It does not deploy the application or claim coverage for slices that do not exist yet.

## Triggers and checks

The CI workflow runs on pull requests, pushes to main, and manual dispatch.
It checks TypeScript types, documentation-tool behavior, handoff structure, local links, SVG/JSON validity, embedded JavaScript syntax, generated-file consistency, stale stack references, and static-site assembly.
Both verification and Pages assembly use Node.js 24 LTS and `npm ci` against the committed lockfile.
No Python interpreter is used by current documentation CI.
`npm run check` fails on generated-file drift; `npm run docs:render` updates the derived files locally.
GitHub Actions dependencies are pinned to immutable commit SHAs.
The check job has read-only repository permissions and a ten-minute timeout.

## Quality regression gates

Every pull request and push to main runs Fallow, Sentrux and commit-standard checks in addition to handoff validation.
Missing binaries, invalid results, missing Sentrux baselines and scanner failures fail the job; no continue-on-error bypass is configured.
The scanners check code structure and static findings; they do not prove runtime performance or Rust parity.

- Fallow 3.30.0 is locked through npm and runs audit in new-only mode against the PR base or push-before commit; manual dispatch compares HEAD^.
- Fallow rejects new dead-code, duplication and complexity findings and source parse failures; existing findings remain visible through full scans.
- Fallow excludes only generated site output, generated snippets and generated index.html; application and tooling source stay in scope.
- Sentrux 0.5.7 and its Linux grammars are version-pinned and SHA-256-verified before execution.
- The committed Sentrux floor is 6491, with zero cycles and zero god files; its original JSON is preserved.
- CI also measures base and candidate in temporary tracked-file snapshots using the same scanner and grammars, so improvements cannot later regress to the initial floor.
- Native Sentrux permits a 0.02 quality-signal drop; an additional JSON comparison rejects any score drop beyond floating-point noise, any added cycles/god files/complex functions, and coupling growth beyond its native 0.05 tolerance.
- Baseline changes cannot weaken the baseline from the base revision; CI never saves candidate measurements over the committed floor.

Local checks after staging new source files (Sentrux uses Git's tracked-file inventory):

```bash
npm run quality:fallow -- --base HEAD
npm run quality:sentrux
npm run commitlint -- --from HEAD^ --to HEAD
```

Install Sentrux 0.5.7 with its matching platform grammars for the local command.
The CI job installs and checks its own scanner; local installation is not assumed on hosted runners.
Do not lower thresholds, expand ignores, reset baselines or replace measured results to clear a failing gate.
Review scanner upgrades explicitly and run both versions on the same revision before changing a baseline.

## Commit standard

Commit headers and pull request titles follow Conventional Commits: type(scope): summary, with optional scope and optional ! before the colon for a breaking change.
Allowed types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style and test.
Headers are limited to 72 characters; the conventional preset also checks subject/type and body/footer formatting.
CI checks the whole new commit range, not only the final commit.
Standard Git-generated merge/revert exceptions are retained for commit history; PR titles are checked without default ignore patterns.
PR title edits rerun the check so the squash title cannot remain stale.

## Documentation delivery

After checks pass on main, a build job assembles an allowlisted _site directory and uploads a short-lived Pages artifact.
The deploy job alone receives pages:write and id-token:write permissions.
It publishes through the github-pages environment using GitHub's official Pages action.
Pull requests do not run the deployment jobs.

Roll back documentation by reverting the relevant commit and letting the same pipeline deploy the previous content.
No application database, microphone, or external integration is involved.

## Application checks

The `app` job runs `npm run check:app` (`scripts/check-app.ts`) and stops at the first failing step.
Steps, in order: workspace typechecks, root Vitest suites, web build, Playwright browser tests, benchmark manifest validation, benchmark correctness smoke (`npm run benchmark -- --smoke`) and the accelerated 24-hour replay (`npm run replay:capture`).
Child processes run with `SANCTUM_ENV=test` and without provider credential variables, so external side effects stay disabled.
Server tests use a `mysql:8.4` service container through `SANCTUM_TEST_MYSQL_URL`; its root password is a non-secret test literal.
Playwright installs only the Chromium headless shell and its system dependencies.
The job has read-only repository permissions, no secrets, no deployment, and a twenty-minute timeout.
The benchmark smoke fails on a failed operation or an invalid result record, never on timing; comparative timing gates belong on a controlled benchmark host, and Rust parity remains unverified ([benchmarks/README.md](../benchmarks/README.md)).
Run it locally with `npm run check:app`; without `SANCTUM_TEST_MYSQL_URL`, server tests start a throwaway Docker container, but the replay step needs the URL.
The Vitest suites include the TypeScript SDK, the v1 contract snapshot (`sdk/openapi.json` and the generated SDK files must match `npm run sdk:generate`), and MCP over Streamable HTTP with fixture-issuer tokens.

## Rust benchmark reference

The `rust-bench` job installs Rust 1.97.1 and runs `cargo test --release --locked --manifest-path benchmarks/rust/Cargo.toml` on the benchmark-only crate.
It checks fixture generation against the TypeScript values, frame validation, top-k tie order, boundary cues, WAV validation and date arithmetic.
It runs no timing comparison; Rust/TypeScript comparisons (`scripts/benchmark-compare.ts`) belong on a controlled benchmark host.

## Python SDK

The `python-sdk` job installs `sdk/python` (its only dependency is `httpx`) into a virtual environment; no Python enters an application image.
It replays the golden exchanges in `sdk/fixtures/wire-cases.json` that the TypeScript SDK also replays, then runs the Python example end to end against the database-free fixture API (`server/tests/support/fixture-server.ts`).
The job has no secrets, no database, and a ten-minute timeout.
Run it locally: `pip install ./sdk/python`, then `cd sdk/python && python3 -m unittest discover -s tests -p 'test_*.py'`.

## When implementation is added

Extend `scripts/check-app.ts` with real Effect interruption/cleanup and later server and browser checks as each implementation slice lands.
Run deterministic performance smoke/correctness checks in normal CI; keep Rust comparisons and regression timing gates on a controlled benchmark host.
Do not add permanently passing placeholders for missing components.
The handoff validator deliberately permits new application directories; it still validates the planning and reference documents.
Introduce application deployment only after a deployment target and its operational permissions are explicitly configured.

## Cost and limits

Standard GitHub-hosted runner usage is free for public repositories.
Public visibility does not remove job duration, concurrency, artifact-storage, or other platform limits, and larger runners remain billable.
This workflow uses standard Ubuntu runners and short artifact retention.

Sources: [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) and [Actions limits](https://docs.github.com/en/actions/reference/limits).
