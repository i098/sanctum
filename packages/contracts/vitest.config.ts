import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'contracts', include: ['tests/**/*.test.ts'] },
});
