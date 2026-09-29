import { defineConfig, devices } from '@playwright/test';

// Workers re-evaluate this file with their own pid, so pin the port in the env they inherit.
process.env['WEB_E2E_PORT'] ??= String(3200 + (process.pid % 800));
const port = Number(process.env['WEB_E2E_PORT']);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid WEB_E2E_PORT: ${port}`);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL, headless: true, viewport: { width: 1280, height: 720 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } }],
  webServer: {
    command: `vite --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
