# CI/CD

## Current scope

The pipeline validates and publishes the documentation and visual reference that exist today.
It does not pretend to test or deploy the future meeting application.

## Triggers and checks

The CI workflow runs on pull requests, pushes to main, and manual dispatch.
It checks documentation-tool behavior, Python syntax, handoff structure, local links, SVG/JSON validity, embedded JavaScript syntax, generated-file consistency, and static-site assembly.
GitHub Actions dependencies are pinned to immutable commit SHAs.
The check job has read-only repository permissions and a ten-minute timeout.

## Documentation delivery

After checks pass on main, a build job assembles an allowlisted _site directory and uploads a short-lived Pages artifact.
The deploy job alone receives pages:write and id-token:write permissions.
It publishes through the github-pages environment using GitHub's official Pages action.
Pull requests do not run the deployment jobs.

Roll back documentation by reverting the relevant commit and letting the same pipeline deploy the previous content.
No application database, microphone, or external integration is involved.

## When implementation is added

Add real backend, web, SDK, MCP, MySQL, and browser checks with each corresponding implementation slice.
Do not add permanently passing placeholders for missing components.
The handoff validator deliberately permits new application directories; it still validates the planning and reference documents.
Introduce application deployment only after a deployment target and its operational permissions are explicitly configured.

## Cost and limits

Standard GitHub-hosted runner usage is free for public repositories.
Public visibility does not remove job duration, concurrency, artifact-storage, or other platform limits, and larger runners remain billable.
This workflow uses standard Ubuntu runners and short artifact retention.

Sources: [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) and [Actions limits](https://docs.github.com/en/actions/reference/limits).
