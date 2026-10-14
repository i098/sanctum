# Contributing to Sanctum

Sanctum is currently an implementation blueprint with a working documentation pipeline.
The first application implementation is organized in docs/build/tasks/todo.md.

## Before a change

Read AGENTS.md, docs/build/HANDOFF.md, and the relevant plan sections.
Keep the website-first, silent, fullscreen design and shared context model intact.
Open an issue for a change to a settled product decision or a large architectural change.
A focused implementation or documentation fix can go directly to a pull request.

## Local checks

```bash
npm ci
npm run docs:render
npm run check
npm run docs:build
```

Commit regenerated docs/build/blueprint.html, docs/build/EXECUTE.txt, and docs/build/snippets when changing their source documents.
The sources are docs/build/HANDOFF.md, docs/build/tasks/plan.md, docs/build/tasks/todo.md, and scripts/handoff.ts and scripts/handoff-template.html.
Do not hand-edit generated output.
Node.js 24.12+ runs the TypeScript tools directly; `npm run check` separately typechecks them and runs behavior tests.
Python is needed only when implementing/testing the thin Python client SDK.
The current checks validate documentation and handoff integrity; application tests must be added with implementation.

## Quality and commit checks

Stage new files before running Sentrux so its tracked-file scan includes them.
Run npm run quality:fallow -- --base HEAD and npm run quality:sentrux before submitting code.
Keep the committed Sentrux baseline intact; fix regressions rather than weakening gates.
Use Conventional Commits, for example ci: enforce quality gates or fix(capture): recover interrupted uploads.
Use a matching PR title; keep each header at most 72 characters.
Check commits with npm run commitlint -- --from HEAD^ --to HEAD.
See [CI/CD details](docs/CI.md) for versions, baseline behavior and exceptions.

## Pull requests

Explain the user-visible behavior, the relevant task, and the checks you actually ran.
Use small, reviewable changes and preserve unrelated work.
Include a browser comparison when changing the visual reference or future interface.
Do not claim a model, provider, or deployment was verified if it was only mocked.

## Privacy and conduct

Use synthetic fixtures and redact sensitive data before posting issues, logs, or examples.
Never commit credentials, recordings of real people, customer data, or production exports.
Be respectful, specific, and constructive in reviews.
By contributing, you agree that your contributions are provided under the repository's FSL-1.1-ALv2 license.

## Changelog and releases

[CHANGELOG.md](CHANGELOG.md) follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).
Do not edit CHANGELOG.md in a feature PR.

- Add one fragment per PR: `changelog.d/<issue>.<type>.md`, where `<issue>` is the issue the PR closes and `<type>` is `added`, `changed`, `fixed`, `removed`, `deprecated`, or `security`.
  The file holds one plain sentence without the issue link; the release step adds the link. Example, `changelog.d/58.fixed.md`: `Sign-in no longer loops after a workspace is deleted.`
- A PR with nothing to note, such as a test-only change, gets the `no changelog` label instead. CI fails a PR with neither.
- To release, run `uvx towncrier==26.9.0 build --version X.Y.Z` on a branch (`--draft` previews it), update the link references at the bottom of CHANGELOG.md, and open a PR. After it merges, tag the merge commit `vX.Y.Z` and create the GitHub release with that section as notes.
