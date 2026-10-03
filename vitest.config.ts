import { defineConfig } from 'vitest/config';

// One runner for every application workspace; each project keeps its own config.
export default defineConfig({
  test: {
    projects: ['packages/contracts', 'server', 'sdk/typescript', 'web-app', 'deploy/cloudflare'],
  },
});
