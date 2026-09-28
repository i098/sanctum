"""Behavior checks for the documentation publication boundary."""
import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

site = load('build_site')
js = load('check_javascript')

class DocumentationChecks(unittest.TestCase):
    def test_publish_allowlist_excludes_secrets_and_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in site.FILES:
                (root / name).write_text('public document')
            for name in site.DIRECTORIES:
                (root / name).mkdir()
                (root / name / 'reference.txt').write_text('public reference')
            (root / '.env').write_text('PRIVATE_TEST_VALUE=do-not-publish')
            (root / '.git').mkdir()
            (root / '.git/config').write_text('private repository config')
            (root / 'application.py').write_text('private source fixture')
            with patch.multiple(site, ROOT=root, SITE=root / '_site'), contextlib.redirect_stdout(io.StringIO()):
                site.main()
            published = {p.relative_to(root / '_site').as_posix() for p in (root / '_site').rglob('*') if p.is_file()}
            self.assertIn('index.html', published)
            self.assertIn('sitemap.xml', published)
            self.assertNotIn('.env', published)
            self.assertNotIn('.git/config', published)
            self.assertNotIn('application.py', published)

    def test_generated_site_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'preserve'
            target.mkdir()
            (target / 'keep.txt').write_text('keep')
            (root / '_site').symlink_to(target, target_is_directory=True)
            with patch.multiple(site, ROOT=root, SITE=root / '_site'):
                with self.assertRaises(AssertionError):
                    site.main()
            self.assertEqual((target / 'keep.txt').read_text(), 'keep')

    def test_script_selection_skips_data_and_external_scripts(self):
        parser = js.Scripts()
        parser.feed('<script type="application/json">{"not":"javascript"}</script>'
                    '<script src="remote.js"></script>'
                    '<script type="module">const valid = 1;</script>')
        self.assertEqual(parser.blocks, ['const valid = 1;'])

if __name__ == '__main__':
    unittest.main()
