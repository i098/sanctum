import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const api = 'http://127.0.0.1:7102';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3102,
    proxy: {
      '/api': api,
      '/healthz': api,
      '/readyz': api,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
