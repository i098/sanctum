/** Documentation tooling only; no application or provider calls. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, existsSync, cpSync, rmSync } from 'node:fs';
import { resolve, join, dirname, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { XMLValidator } from 'fast-xml-parser';

const ROOT = resolve(import.meta.dirname, '..');
export const FILES = ['index.html', 'EXECUTE.txt', 'HANDOFF.md', 'README.md', 'AGENTS.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md'];
export const DIRECTORIES = ['design', 'docs', 'tasks', 'snippets'];
const SOURCES = ['HANDOFF.md', 'tasks/plan.md', 'tasks/todo.md'];
const IGNORED = new Set(['.git', '_site', 'node_modules', '.venv', 'dist', '.work']);
const read = (root: string, name: string) => readFileSync(join(root, name), 'utf8');
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');

function files(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    if (IGNORED.has(entry.name)) return [];
    const name = join(prefix, entry.name);
    return entry.isDirectory() ? files(root, name) : [name];
  });
}

/** Small renderer for this repository's maintained Markdown subset. */
export function generatedFiles(root: string): Map<string, string> {
  const [handoff, plan, todo] = SOURCES.map(name => read(root, name));
  const outputs = new Map<string, string>();
  const blocks: { id: string; name: string; contents: string }[] = [];
  function inline(text: string): string {
    const tokens: string[] = [];
    let result = escape(text.replace(/`([^`]+)`/g, (_, code: string) => {
      tokens.push(`<code>${escape(code)}</code>`);
      return `@@CODE${tokens.length - 1}@@`;
    }));
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return result.replace(/@@CODE(\d+)@@/g, (_, id: string) => tokens[Number(id)]);
  }
  function markdown(text: string): string {
    const lines = text.split(/\r?\n/);
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (line.startsWith('```')) {
        const language = line.slice(3).trim();
        const body: string[] = [];
        for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
        assert(i < lines.length, 'Unclosed code block');
        const names: Record<string, string> = { json: 'context-response.json', typescript: 'sdk-example.ts', bash: 'check-commands.sh' };
        const name = names[language] ?? `example-${blocks.length}.txt`;
        assert(!outputs.has(`snippets/${name}`), `Duplicate snippet: ${name}`);
        const id = `code-${blocks.length}`;
        const contents = body.join('\n') + '\n';
        blocks.push({ id, name, contents });
        outputs.set(`snippets/${name}`, contents);
        out.push(`<div class="code-intro"><span>Proposed contract · ${escape(name)}</span><a href="snippets/${name}" download>Download</a></div><div id="${id}" class="code-view"><p class="small">Loading syntax view…</p></div>`);
        i++; continue;
      }
      if (line.startsWith('|')) {
        const rows: string[][] = [];
        while (i < lines.length && lines[i].startsWith('|')) {
          const cells = lines[i++].replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
          if (!cells.every(cell => /^[-: ]+$/.test(cell))) rows.push(cells);
        }
        const head = rows.shift();
        assert(head, 'Missing table heading');
        out.push('<div class="table-wrap"><table><thead><tr>' + head.map(cell => `<th>${inline(cell)}</th>`).join('') + '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(cell => `<td>${inline(cell)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }
      if (line.startsWith('#')) {
        const level = Math.min(line.match(/^#+/)![0].length, 5);
        out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ''))}</h${level}>`);
        i++; continue;
      }
      if (line.startsWith('- ') || /^\d+\. /.test(line)) {
        const ordered = !line.startsWith('- ');
        const pattern = ordered ? /^\d+\. / : /^- /;
        const items: string[] = [];
        while (i < lines.length && pattern.test(lines[i])) {
          let value = lines[i++].replace(pattern, '');
          const checkbox = value.startsWith('[ ] ');
          if (checkbox) value = value.slice(4);
          items.push(checkbox ? `<li class="check"><span aria-hidden="true">□</span><span>${inline(value)}</span></li>` : `<li>${inline(value)}</li>`);
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.join('')}</${tag}>`); continue;
      }
      const paragraph: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(#|\||```|- |\d+\. )/.test(lines[i])) paragraph.push(lines[i++]);
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    }
    return out.join('\n');
  }
  const headings = [...plan.matchAll(/^## (\d{2})\. (.+)$/gm)];
  assert.equal(headings.length, 20);
  const sections = headings.map((heading, i) => ({
    id: `s${heading[1]}`, number: heading[1], title: heading[2],
    html: markdown(plan.slice(heading.index! + heading[0].length, headings[i + 1]?.index ?? plan.length))
  }));
  const taskParts = todo.split(/(?=^## )/m).slice(1);
  const taskCount = taskParts.filter(part => part.startsWith('## T')).length;
  assert.equal(taskCount, 26);
  const tasks = taskParts.map(part => {
    const index = part.indexOf('\n');
    const title = part.slice(3, index);
    const slug = 't' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `<details class="task" id="${slug}"><summary>${escape(title)}</summary><div class="detail-body">${markdown(part.slice(index + 1))}</div></details>`;
  }).join('');
  const fullPrompt = [handoff, plan, todo].join('\n\n---\n\n');
  outputs.set('EXECUTE.txt', fullPrompt);
  const values: Record<string, string> = {
    TASKCOUNT: String(taskCount),
    NAVIGATION: sections.map(s => `<button type="button" data-target="${s.id}"><span>${s.number}</span>${escape(s.title)}</button>`).join(''),
    SECTIONS: sections.map(s => `<details class="section" id="${s.id}"${['s01', 's02'].includes(s.id) ? ' open' : ''}><summary><span class="section-number">${s.number}</span><h2>${escape(s.title)}</h2></summary><div class="detail-body">${s.html}</div></details>`).join(''),
    TASKS: tasks, HANDOFF: escape(handoff),
    BUNDLEDATA: JSON.stringify({ full_prompt: fullPrompt, code_blocks: blocks }).replaceAll('<', '\\u003c')
  };
  outputs.set('index.html', read(root, 'scripts/handoff-template.html').replace(/TASKCOUNT|NAVIGATION|SECTIONS|TASKS|HANDOFF|BUNDLEDATA/g, token => values[token]));
  return outputs;
}

export function inlineScripts(html: string): { source: string; module: boolean }[] {
  const result: { source: string; module: boolean }[] = [];
  function visit(node: DefaultTreeAdapterMap['node']) {
    if ('tagName' in node && node.tagName === 'script') {
      const attrs = Object.fromEntries(node.attrs.map(attr => [attr.name, attr.value]));
      if (!('src' in attrs) && ['', 'module', 'text/javascript', 'application/javascript'].includes(attrs.type ?? '')) {
        result.push({ source: node.childNodes.map(child => 'value' in child ? child.value : '').join(''), module: attrs.type === 'module' });
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  }
  visit(parse(html));
  return result;
}

export function assertCurrentStack(text: string, name: string) {
  // Pinned historical source URLs are evidence, not runtime instructions.
  const prose = text.replace(/https?:\/\/[^\s)"<>]+/g, '');
  assert(!/FastAPI|FastMCP|Pipecat|Pydantic|Authlib|NumPy|boto3|Connector\/Python|WebRTC|\/api\/offer|media-port|pnpm|backend\/|realtime\/|scripts\/[\w-]+\.py/.test(prose), `Stale stack reference: ${name}`);
}

export function check(root: string) {
  const required = [...FILES, 'tasks/plan.md', 'tasks/todo.md', 'docs/DESIGN.md', 'docs/DECISIONS.md', 'design/listener-reference.svg', 'design/listener-reference.html', '.github/workflows/ci.yml'];
  required.forEach(name => assert(lstatSync(join(root, name)).isFile(), `Missing handoff: ${name}`));
  const todo = read(root, 'tasks/todo.md');
  assert.deepEqual([...todo.matchAll(/^## T(\d{2})\./gm)].map(match => match[1]), Array.from({ length: 26 }, (_, i) => String(i + 1).padStart(2, '0')));
  for (const part of todo.split(/(?=^## T\d{2}\.)/m).slice(1)) {
    const task = Number(part.match(/^## T(\d{2})/)![1]);
    const dependencies = part.match(/^Depends on: (.+)$/m)?.[1] ?? '';
    for (const target of dependencies.matchAll(/T(\d{2})/g)) assert(Number(target[1]) < task, `Invalid T${task} dependency`);
  }
  for (const name of files(root)) {
    if (!name.endsWith('.md')) continue;
    const text = read(root, name);
    assert(!text.includes('/Users/'), `Nonportable path: ${name}`);
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (target.includes('://') || target.startsWith('#')) continue;
      assert(existsSync(resolve(root, dirname(name), target.split('#')[0])), `Broken link: ${name}: ${target}`);
    }
  }
  for (const name of [...SOURCES, 'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/CI.md', 'docs/DECISIONS.md', 'scripts/handoff-template.html', '.github/workflows/ci.yml']) assertCurrentStack(read(root, name), name);
  assert(!files(root).some(name => /^(scripts|tests)\/.*\.py$/.test(name)), 'Stale Python documentation tooling');
  assert.equal(XMLValidator.validate(read(root, 'design/listener-reference.svg')), true, 'Invalid SVG XML');
  JSON.parse(read(root, 'snippets/context-response.json'));
  const generated = generatedFiles(root);
  for (const [name, expected] of generated) assert.equal(read(root, name), expected, `Stale generated file: ${name}; run npm run docs:render`);
  const expectedSnippets = [...generated.keys()].filter(name => name.startsWith('snippets/')).sort();
  assert.deepEqual(files(join(root, 'snippets')).map(name => `snippets/${name}`).sort(), expectedSnippets, 'Stale snippet output');
  let count = 0;
  for (const name of ['index.html', ...files(join(root, 'design')).filter(name => name.endsWith('.html')).map(name => `design/${name}`)]) {
    for (const script of inlineScripts(read(root, name))) {
      const result = spawnSync(process.execPath, ['--check', '--input-type=' + (script.module ? 'module' : 'commonjs')], { input: script.source, encoding: 'utf8' });
      assert.equal(result.status, 0, `${name}: ${result.stderr || result.error}`);
      count++;
    }
  }
  assert(count >= 2, 'No documentation JavaScript checked');
  console.log(`PASS: 26 tasks, ordered dependencies, links, SVG/JSON, current stack, generated output, ${count} scripts`);
}

export function buildSite(root: string) {
  const site = join(root, '_site');
  assert(!lstatSync(site, { throwIfNoEntry: false })?.isSymbolicLink(), '_site must not be a symlink');
  // Validate inputs before replacing generated output; never publish the checkout.
  for (const name of [...FILES, ...DIRECTORIES]) {
    const info = lstatSync(join(root, name));
    assert(!info.isSymbolicLink(), `Invalid site input: ${name}`);
    assert(DIRECTORIES.includes(name) ? info.isDirectory() : info.isFile(), `Invalid site type: ${name}`);
    if (info.isDirectory()) {
      for (const entry of files(root, name)) {
        assert(!lstatSync(join(root, entry)).isSymbolicLink(), `Symlink in site inputs: ${entry}`);
        assert(!entry.split('/').some(part => part.startsWith('.')), `Hidden site input: ${entry}`);
        assert(['.md', '.html', '.svg', '.json', '.ts', '.sh', '.txt'].includes(extname(entry)), `Unexpected site input: ${entry}`);
      }
    }
  }
  rmSync(site, { recursive: true, force: true });
  mkdirSync(site);
  for (const name of [...FILES, ...DIRECTORIES]) cpSync(join(root, name), join(site, name), { recursive: true, filter: source => !IGNORED.has(source.split('/').at(-1)!) });
  writeFileSync(join(site, '.nojekyll'), '');
  writeFileSync(join(site, 'robots.txt'), 'User-agent: *\nAllow: /\nSitemap: https://i098.github.io/sanctum/sitemap.xml\n');
  writeFileSync(join(site, 'sitemap.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://i098.github.io/sanctum/</loc></url><url><loc>https://i098.github.io/sanctum/design/listener-reference.html</loc></url></urlset>\n');
  console.log(`PASS: allowlisted site assembled (${files(site).length} files)`);
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === 'check') check(ROOT);
  else if (command === 'build') buildSite(ROOT);
  else if (command === 'render') {
    for (const [name, contents] of generatedFiles(ROOT)) {
      mkdirSync(dirname(join(ROOT, name)), { recursive: true });
      writeFileSync(join(ROOT, name), contents);
    }
    console.log('PASS: generated HTML, execution brief and snippets');
  } else throw new Error('Usage: node scripts/handoff.ts check|render|build');
}
