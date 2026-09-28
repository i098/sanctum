"""Check executable inline JavaScript in the maintained documentation pages."""
from html.parser import HTMLParser
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

class Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.current = None
        self.blocks = []

    def handle_starttag(self, tag, attrs):
        if tag != 'script':
            return
        attrs = dict(attrs)
        if 'src' not in attrs and attrs.get('type', '') in ('', 'module', 'text/javascript', 'application/javascript'):
            self.current = []

    def handle_data(self, data):
        if self.current is not None:
            self.current.append(data)

    def handle_endtag(self, tag):
        if tag == 'script' and self.current is not None:
            self.blocks.append(''.join(self.current))
            self.current = None

def main():
    count = 0
    for path in (ROOT / 'index.html', *sorted((ROOT / 'design').glob('*.html'))):
        parser = Scripts()
        parser.feed(path.read_text(encoding='utf-8'))
        for block in parser.blocks:
            with tempfile.TemporaryDirectory() as directory:
                script = Path(directory) / 'inline.mjs'
                script.write_text(block, encoding='utf-8')
                subprocess.run(['node', '--check', str(script)], check=True)
            count += 1
    assert count >= 2, 'Expected the documentation scripts to be checked'
    print(f'PASS: {count} executable inline JavaScript blocks')

if __name__ == '__main__':
    main()
