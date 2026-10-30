#!/usr/bin/env python3
"""Inventory licenses from pinned source inputs without fetching or installing."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'docs/open-source/dependencies.json'


def inventory(root=ROOT, resolve=False):
    lock = (root / 'pnpm-lock.yaml').read_text()
    installed = {}
    for pattern in ['*/node_modules/*/package.json', '*/node_modules/@*/*/package.json']:
        for path in (root / 'node_modules/.pnpm').glob(pattern):
            value = json.loads(path.read_text())
            installed[(value.get('name'), value.get('version'))] = value.get('license', 'UNKNOWN')
    rows = []
    # A source-only checkout has no installed packages. Preserve already reviewed
    # exact-version metadata instead of turning it back into UNKNOWN on refresh.
    previous_path = root / 'docs/open-source/dependencies.json'
    previous = json.loads(previous_path.read_text()) if previous_path.is_file() else {}
    reviewed = {(r['ecosystem'], r['name'], r['version']): r
                for r in previous.get('dependencies', []) if r['license'] != 'UNKNOWN'}
    package_section = lock.split('\npackages:\n', 1)[1].split('\nsnapshots:\n', 1)[0]
    for key in re.findall(r'^  (\S+):\s*$', package_section, re.M):
        key = key.strip("'")
        name, version = key.rsplit('@', 1)
        license_id = installed.get((name, version), 'UNKNOWN')
        rows.append({'ecosystem': 'npm', 'name': name, 'version': version, 'license': license_id,
                     'evidence': 'installed package.json at locked version' if license_id != 'UNKNOWN' else 'lock-only; inspect upstream package before binary redistribution'})
    inputs = {'pnpm-lock.yaml': hashlib.sha256(lock.encode()).hexdigest()}
    names = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z']).decode().split('\0')
    for name in names:
        if not (name.endswith('/go.mod') or name.endswith('/requirements.txt')):
            continue
        path = root / name
        content = path.read_text()
        inputs[name] = hashlib.sha256(content.encode()).hexdigest()
        if name.endswith('/go.mod'):
            for module, version in re.findall(r'^\s*(?:require\s+)?([\w./-]+)\s+(v\S+)', content, re.M):
                rows.append({'ecosystem': 'go', 'name': module, 'version': version, 'license': 'UNKNOWN', 'evidence': name})
        else:
            for package, version in re.findall(r'^([\w.-]+)==([^\s#]+)', content, re.M):
                rows.append({'ecosystem': 'python', 'name': package, 'version': version,
                             'license': 'AGPL-3.0-or-later OR commercial' if package.lower() == 'pymupdf' else 'UNKNOWN', 'evidence': name})
    for row in rows:
        prior = reviewed.get((row['ecosystem'], row['name'], row['version']))
        if row['license'] == 'UNKNOWN' and prior:
            row['license'], row['evidence'] = prior['license'], prior['evidence']
        if row['name'] == 'sentencepiece' and row['version'] == '0.2.1':
            row['license'] = 'Apache-2.0'
            row['evidence'] = 'https://github.com/google/sentencepiece/blob/v0.2.1/LICENSE'
    if resolve:
        for row in rows:
            if row['license'] != 'UNKNOWN' or row['ecosystem'] not in {'npm', 'python'}:
                continue
            url = ('https://registry.npmjs.org/' + row['name'] + '/' + row['version']) if row['ecosystem'] == 'npm' else ('https://pypi.org/pypi/' + row['name'] + '/' + row['version'] + '/json')
            try:
                with urllib.request.urlopen(url, timeout=20) as response:
                    metadata = json.load(response)
                if row['ecosystem'] == 'python':
                    metadata = metadata['info']
                label = metadata.get('license_expression') or metadata.get('license')
                if not label:
                    label = '; '.join(c for c in metadata.get('classifiers', []) if c.startswith('License ::'))
                if isinstance(label, str) and label.strip():
                    row['license'] = label.strip()[:200] if len(label) < 250 else 'SEE UPSTREAM LICENSE TEXT'
                    row['evidence'] = url
            except Exception:
                row['evidence'] += '; metadata unavailable, not assumed licensed'
    return {'schemaVersion': 1, 'inputSha256': inputs, 'dependencies': sorted(rows, key=lambda r:(r['ecosystem'], r['name'], r['version'])),
            'coverage': {'npmLocked': sum(r['ecosystem'] == 'npm' for r in rows),
                         'unknownLicenseMetadata': sum(r['license'] == 'UNKNOWN' for r in rows),
                         'notCovered': ['transitive Python/OS packages inside externally supplied images', 'firmware or model binaries not in this source checkout']},
            'warning': 'Metadata inventory, not legal clearance or a complete binary SBOM. Original licenses govern. UNKNOWN is never MIT.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--resolve', action='store_true', help='Read exact-version license metadata from npm/PyPI; never upload source')
    args = parser.parse_args()
    value = inventory(resolve=args.resolve)
    text = json.dumps(value, indent=2, ensure_ascii=False) + '\n'
    if args.check:
        current = json.loads(OUTPUT.read_text())
        # Installed metadata can differ on a source-only checkout; locked inputs cannot.
        if current['inputSha256'] != value['inputSha256']:
            raise SystemExit('Dependency inputs changed; regenerate inventory')
        value = current
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(text)
    print(json.dumps(value['coverage']))
