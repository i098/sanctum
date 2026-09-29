import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'sdk', include: ['tests/**/*.test.ts'] },
});
