import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/support/mysql-server.ts'],
    // A database across the internet (TiDB Cloud, ~33 ms per statement) needs 50-110 s to migrate one test database.
    testTimeout: Number(process.env.SANCTUM_TEST_TIMEOUT_MS ?? 30_000),
    hookTimeout: 120_000,
  },
});
