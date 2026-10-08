import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Server-side secret names from plan section 17; each gets a unique canary value during the build. */
const SECRETS = [
  'MYSQL_PASSWORD',
  'R2_SECRET_ACCESS_KEY',
  'DEEPGRAM_API_KEY',
  'CARTESIA_API_KEY',
  'CEREBRAS_API_KEY',
  'ANTHROPIC_API_KEY',
  'PYANNOTE_API_KEY',
  'PIPEDREAM_CLIENT_SECRET',
  'SANCTUM_SESSION_SECRET',
];

const outDir = mkdtempSync(join(tmpdir(), 'sanctum-web-build-'));
const files: Record<string, string> = {};

beforeAll(async () => {
  const saved = { ...process.env };
  for (const name of SECRETS) process.env[name] = `canary-${name}-7f3a9c`;
  try {
    await build({ root: join(import.meta.dirname, '..'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  } finally {
    process.env = saved;
  }
  for (const file of readdirSync(outDir, { recursive: true, withFileTypes: true })) {
    if (file.isFile()) files[join(file.parentPath, file.name).slice(outDir.length)] = readFileSync(join(file.parentPath, file.name), 'utf8');
  }
}, 120_000);

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe('production web build', () => {
  it('contains no server secret present in the build environment', () => {
    expect(Object.keys(files).length).toBeGreaterThan(1);
    for (const [file, text] of Object.entries(files)) expect(text, file).not.toMatch(/canary-\w+-7f3a9c/);
  });

  it('loads only same-origin external scripts and styles, as the CSP requires', () => {
    const html = files['/index.html'] ?? '';
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(html).not.toMatch(/<style|\sstyle=/);
    // The tab icon is an inline SVG, which the CSP's `img-src data:` allows.
    for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) expect(url).toMatch(/^(?:\/assets\/|data:image\/svg\+xml,)/);
  });
});
