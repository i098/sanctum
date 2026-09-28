"""Validate the handoff package, not a future application implementation."""
from pathlib import Path
import json
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = ('README.md', 'AGENTS.md', 'HANDOFF.md', 'tasks/plan.md', 'tasks/todo.md',
            'docs/DESIGN.md', 'docs/DECISIONS.md', 'design/listener-reference.svg',
            'design/listener-reference.html', 'index.html', 'EXECUTE.txt', 'LICENSE',
            'CONTRIBUTING.md', 'SECURITY.md', '.github/workflows/ci.yml')

def main():
    for name in REQUIRED:
        assert (ROOT / name).is_file(), f'Missing handoff: {name}'
    todo = (ROOT / 'tasks/todo.md').read_text(encoding='utf-8')
    tasks = re.findall(r'^## T(\d{2})\.', todo, re.M)
    assert tasks == [f'{n:02}' for n in range(1, 27)], 'Expected ordered T01–T26'
    for part in re.split(r'(?=^## T\d{2}\.)', todo, flags=re.M)[1:]:
        task = int(re.match(r'## T(\d{2})', part).group(1))
        dep = re.search(r'^Depends on: (.+)$', part, re.M)
        if dep:
            for target in re.findall(r'T(\d{2})', dep.group(1)):
                assert int(target) < task, f'Invalid dependency: T{task} -> T{target}'
    for path in ROOT.rglob('*.md'):
        if any(part in {'.git', '_site', 'node_modules', '.venv'} for part in path.relative_to(ROOT).parts):
            continue
        text = path.read_text(encoding='utf-8')
        assert '/Users/' not in text, f'Nonportable path in {path}'
        for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', text):
            if '://' in target or target.startswith('#'):
                continue
            local = target.split('#')[0]
            assert (path.parent / local).exists(), f'Broken link: {path}: {target}'
    ET.parse(ROOT / 'design/listener-reference.svg')
    json.loads((ROOT / 'snippets/context-response.json').read_text(encoding='utf-8'))
    expected = '\n\n---\n\n'.join((ROOT / p).read_text(encoding='utf-8') for p in ('HANDOFF.md', 'tasks/plan.md', 'tasks/todo.md'))
    assert (ROOT / 'EXECUTE.txt').read_text(encoding='utf-8') == expected, 'Regenerate EXECUTE.txt'
    print('PASS: required files, 26 tasks, dependencies, portable links, SVG, JSON, OSS files, generated brief')

if __name__ == '__main__':
    main()
