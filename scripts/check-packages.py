"""Release identity checks, not registry access or authorization."""
import argparse
import json
import re
import tomllib
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--kind', choices=['all', 'npm', 'python'], default='all')
parser.add_argument('--version')
args = parser.parse_args()
if args.version is not None and re.fullmatch(r'\d+\.\d+\.\d+', args.version) is None:
    raise SystemExit('A plain reviewed semantic version is required')
root = Path(__file__).resolve().parent.parent
if args.kind in ['all', 'npm']:
    data = json.loads((root/'packages/vercel/package.json').read_text())
    assert data['name'] == '@curbi/vercel' and data['license'] == 'MIT'
    assert data.get('private') is not True and data['publishConfig']['access'] == 'public'
    assert data['repository']['url'] == 'git+https://github.com/Curbi-Inc/curbi-check.git'
    assert data['files'] == ['src', 'README.md', 'LICENSE']
    if args.version: assert data['version'] == args.version
if args.kind in ['all', 'python']:
    for directory, name in [('langchain', 'curbi-langchain'), ('llamaindex', 'curbi-llamaindex')]:
        data = tomllib.loads((root/'packages'/directory/'pyproject.toml').read_text())['project']
        assert data['name'] == name and data['license'] == 'MIT'
        assert data['urls']['Repository'] == 'https://github.com/Curbi-Inc/curbi-check'
        if args.version: assert data['version'] == args.version
print('Reviewed package identities and versions match; registry trust is a separate gate.')
