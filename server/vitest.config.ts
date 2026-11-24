import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
