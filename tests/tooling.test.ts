import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite, FILES, DIRECTORIES, inlineScripts, assertCurrentStack } from '../scripts/handoff.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'sanctum-handoff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  FILES.forEach(name => writeFileSync(join(root, name), 'public document'));
  DIRECTORIES.forEach(name => { mkdirSync(join(root, name)); writeFileSync(join(root, name, 'reference.txt'), 'public reference'); });
  return root;
}

test('publication excludes secrets, repository data and application source', t => {
  const root = fixture(t);
  writeFileSync(join(root, '.env'), 'PRIVATE_TEST_VALUE=do-not-publish');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git/config'), 'private config');
  writeFileSync(join(root, 'application.ts'), 'private source fixture');
  buildSite(root);
  assert(existsSync(join(root, '_site/index.html')));
  assert(existsSync(join(root, '_site/sitemap.xml')));
  for (const name of ['.env', '.git/config', 'application.ts']) assert(!existsSync(join(root, '_site', name)));
});

test('output symlink is rejected without touching its target', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'preserve'));
  writeFileSync(join(root, 'preserve/keep.txt'), 'keep');
  symlinkSync(join(root, 'preserve'), join(root, '_site'));
  assert.throws(() => buildSite(root), /symlink/);
  assert.equal(readFileSync(join(root, 'preserve/keep.txt'), 'utf8'), 'keep');
});

test('nested input symlink and hidden secrets are rejected before replacing site', t => {
  const root = fixture(t);
  buildSite(root);
  symlinkSync(join(root, 'README.md'), join(root, 'docs/private.md'));
  assert.throws(() => buildSite(root), /Symlink/);
  rmSync(join(root, 'docs/private.md'));
  writeFileSync(join(root, 'docs/.env'), 'private fixture');
  assert.throws(() => buildSite(root), /Hidden site input/);
  assert(existsSync(join(root, '_site/index.html')));
});

test('script selection ignores comments, JSON and external scripts', () => {
  const html = '<!-- <script>invalid !!!</script> -->' +
    '<script type="application/json">{"not":"javascript"}</script>' +
    '<script src="remote.js"></script>' +
    '<script TYPE="module">const text = "< >";</script><script>let valid = 1;</script>';
  assert.deepEqual(inlineScripts(html), [
    { source: 'const text = "< >";', module: true },
    { source: 'let valid = 1;', module: false }
  ]);
});

test('stale stack fails while pinned historical source URLs remain valid', () => {
  assert.throws(() => assertCurrentStack('Use FastAPI and python3 scripts/dev.py', 'fixture'), /Stale stack/);
  assert.doesNotThrow(() => assertCurrentStack('[historical](https://github.com/example/repo/blob/sha/backend/app.py)\nUse TypeScript + Effect. Python SDK is a client.', 'fixture'));
});
