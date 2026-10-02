import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'cloudflare', include: ['tests/**/*.test.ts'] },
});
