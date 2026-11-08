"""Release identity checks, not registry access or authorization."""
import argparse
import json
import re
import tomllib
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--kind', choices=['all', 'npm', 'python'], default='all')
parser.add_argument('--version')
parser.add_argument('--package', help='check one package only')
args = parser.parse_args()
if args.version is not None and re.fullmatch(r'\d+\.\d+\.\d+', args.version) is None:
    raise SystemExit('A plain reviewed semantic version is required')
root = Path(__file__).resolve().parent.parent
if args.kind in ['all', 'npm']:
    for directory, name, files in [('vercel', '@curbi/vercel', ['src', 'README.md', 'LICENSE']), ('decisions', '@curbi/decisions', ['src', 'README.md', 'LICENSE', 'CHANGELOG.md'])]:
        if args.package and args.package != name: continue
        data = json.loads((root/'packages'/directory/'package.json').read_text())
        assert data['name'] == name and data['license'] == 'MIT'
        assert data.get('private') is not True and data['publishConfig']['access'] == 'public'
        assert data['repository']['url'] == 'git+https://github.com/Curbi-Inc/curbi-check.git'
        assert data['files'] == files
        if args.version: assert data['version'] == args.version
if args.kind in ['all', 'python']:
    for directory, name in [('langchain', 'curbi-langchain'), ('llamaindex', 'curbi-llamaindex'), ('decisions-py', 'curbi-decisions')]:
        if args.package and args.package != name: continue
        data = tomllib.loads((root/'packages'/directory/'pyproject.toml').read_text())['project']
        assert data['name'] == name and data['license'] == 'MIT'
        assert data['urls']['Repository'] == 'https://github.com/Curbi-Inc/curbi-check'
        if args.version: assert data['version'] == args.version
# The decisions packages also pin the adapter's own version string.
if args.kind in ['all', 'npm', 'python'] and (not args.package or args.package in ['@curbi/decisions', 'curbi-decisions']):
    checker = re.search(r"CHECKER = '([^']+)'", (root/'adapters/decisions/src/decisions.mjs').read_text()).group(1)
    assert checker == 'curbi-check/decisions ' + json.loads((root/'packages/decisions/package.json').read_text())['version']
    assert checker == 'curbi-check/decisions ' + tomllib.loads((root/'packages/decisions-py/pyproject.toml').read_text())['project']['version']
print('Reviewed package identities and versions match; registry trust is a separate gate.')
