Closes #

## Summary

<!-- One or two sentences: what this PR does. -->

## What changed and why

-

## Related task

<!-- The task in docs/build/tasks/todo.md or the plan section this change belongs to, if any. -->

## Test evidence

<!-- The commands you ran and what they showed. -->

## Checklist

- [ ] One concern in this PR.
- [ ] The title uses the commit format, for example `docs: link handoff files from the README`, and is 72 characters or fewer.
- [ ] Types check (`npm run typecheck`).
- [ ] Tests pass (`npm test`).
- [ ] Handoff check passes (`npm run check`), and the generated files are current (`npm run docs:render`) if their sources changed.
- [ ] Documentation builds (`npm run docs:build`) if docs or handoff sources changed.
- [ ] Application checks pass (`npm run check:app`) if application code changed.
- [ ] Quality gates pass (`npm run quality:fallow -- --base HEAD` and `npm run quality:sentrux`) for new source files; the Sentrux baseline is unchanged.
- [ ] Commit messages pass commitlint (`npm run commitlint -- --from HEAD^ --to HEAD`).
- [ ] No secrets, private recordings, transcripts, or production data are included.
