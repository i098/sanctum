import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/support/mysql-server.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
