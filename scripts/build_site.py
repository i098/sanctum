"""Assemble an allowlisted static site; never publish the whole checkout."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / '_site'
FILES = ('index.html', 'EXECUTE.txt', 'HANDOFF.md', 'README.md', 'AGENTS.md',
         'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md')
DIRECTORIES = ('design', 'docs', 'tasks', 'snippets')

def main():
    # _site is generated output only; reject symlinks before rebuilding it.
    assert not SITE.is_symlink(), '_site must not be a symlink'
    if SITE.exists():
        shutil.rmtree(SITE)
    SITE.mkdir()
    for name in FILES:
        source = ROOT / name
        assert source.is_file() and not source.is_symlink(), f'Invalid site input: {name}'
        shutil.copy2(source, SITE / name)
    for name in DIRECTORIES:
        source = ROOT / name
        assert source.is_dir() and not source.is_symlink(), f'Invalid site directory: {name}'
        assert not any(p.is_symlink() for p in source.rglob('*')), f'Symlink in {name}'
        shutil.copytree(source, SITE / name)
    (SITE / '.nojekyll').write_text('', encoding='utf-8')
    (SITE / 'robots.txt').write_text('User-agent: *\nAllow: /\nSitemap: https://undeemed.github.io/sanctum/sitemap.xml\n', encoding='utf-8')
    (SITE / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        '<url><loc>https://undeemed.github.io/sanctum/</loc></url>'
        '<url><loc>https://undeemed.github.io/sanctum/design/listener-reference.html</loc></url>'
        '</urlset>\n', encoding='utf-8')
    assert (SITE / 'index.html').is_file()
    assert not (SITE / '.git').exists()
    print(f'PASS: allowlisted documentation site assembled ({sum(p.is_file() for p in SITE.rglob("*"))} files)')

if __name__ == '__main__':
    main()
