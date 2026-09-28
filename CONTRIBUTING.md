# Contributing to Sanctum

Sanctum is currently an implementation blueprint with a working documentation pipeline.
The first application implementation is organized in tasks/todo.md.

## Before a change

Read AGENTS.md, HANDOFF.md, and the relevant plan sections.
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

Commit regenerated index.html, EXECUTE.txt, and snippets when changing their source documents.
The sources are HANDOFF.md, tasks/plan.md, tasks/todo.md, and scripts/handoff.ts and scripts/handoff-template.html.
Do not hand-edit generated output.
Node.js 24.12+ runs the TypeScript tools directly; `npm run check` separately typechecks them and runs behavior tests.
Python is needed only when implementing/testing the thin Python client SDK.
The current checks validate documentation and handoff integrity; application tests must be added with implementation.

## Pull requests

Explain the user-visible behavior, the relevant task, and the checks you actually ran.
Use small, reviewable changes and preserve unrelated work.
Include a browser comparison when changing the visual reference or future interface.
Do not claim a model, provider, or deployment was verified if it was only mocked.

## Privacy and conduct

Use synthetic fixtures and redact sensitive data before posting issues, logs, or examples.
Never commit credentials, recordings of real people, customer data, or production exports.
Be respectful, specific, and constructive in reviews.
By contributing, you agree that your contributions are provided under the repository's MIT license.
