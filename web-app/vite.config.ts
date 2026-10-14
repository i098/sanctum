import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const api = 'http://127.0.0.1:7102';

// Production serves `dist/` from the API process (server/src/web.ts) behind Caddy. Only
// `VITE_`-prefixed variables reach the bundle; server secrets never use that prefix.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The CSP allows fonts from 'self' only (server/src/web.ts), so a small font file is never inlined as a data: URI.
  build: { assetsInlineLimit: file => (file.endsWith('.woff2') ? false : undefined) },
  server: {
    port: 3102,
    proxy: {
      // `ws` forwards the live-ingest WebSocket upgrade under /api/v1/listeners.
      '/api': { target: api, ws: true },
      '/auth': api,
      '/mcp': api,
      '/idp': api,
      '/healthz': api,
      '/readyz': api,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
