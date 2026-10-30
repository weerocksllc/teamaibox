#!/usr/bin/env python3
"""Local-only public source preparation; never publishes, rewrites Git or deploys."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def sha(data):
    return hashlib.sha256(data).hexdigest()


def scanner_version(executable):
    value = subprocess.check_output([str(executable), 'version'], text=True).strip()
    if value != '8.30.1':
        raise ValueError('Use the reviewed Gitleaks 8.30.1 binary')
    return value


def sanitize_scan_report(report):
    found = json.loads(report.read_text()) if report.exists() else []
    compact = [{'rule': f['RuleID'], 'path': f['File'], 'line': f['StartLine'],
                'commit': f.get('Commit'), 'fingerprint': f.get('Fingerprint')}
               for f in found]
    # Do not retain Match, Secret, source lines, author identity or commit messages.
    report.write_text(json.dumps(compact, indent=2) + '\n')
    report.chmod(0o600)
    return compact


def write_report(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def files(root):
    return sorted(set(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0')) - {''})


def safe_source(root, name):
    rel = PurePosixPath(name)
    if rel.is_absolute() or '..' in rel.parts or '.git' in rel.parts:
        raise ValueError('unsafe source path')
    path = root / name
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('symlinks are not admitted to public exports: ' + name)
    path.resolve().relative_to(root.resolve())
    return path


def baseline(root):
    rows = []
    for name in files(root):
        path = root / name
        if path.is_file() and not path.is_symlink():
            rows.append({'path': name, 'sha256': sha(path.read_bytes())})
    return {'head': git(root, 'rev-parse', 'HEAD').decode().strip(),
            'refs': git(root, 'show-ref').decode().splitlines(),
            'commits': int(git(root, 'rev-list', '--all', '--count')),
            'shallow': git(root, 'rev-parse', '--is-shallow-repository').decode().strip(),
            'files': rows}


def scan(root, executable, output):
    """Gitleaks reports are always 100% redacted, including its captured logs."""
    output = Path(output).absolute()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    version = scanner_version(executable)
    summaries = {}
    # Stage only Git-known and explicitly inventoried untracked inputs, not .env,
    # node_modules, browser state or ignored audit output.
    with tempfile.TemporaryDirectory(prefix='teamaibox-source-scan-') as temp:
        stage = Path(temp)
        skipped = []
        for name in files(root):
            try:
                source = safe_source(root, name)
            except ValueError:
                skipped.append({'path': name, 'reason': 'symlink-or-unsafe-path'})
                continue
            if not source.is_file():
                continue
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        for scope, args in [('history', ['git', str(root), '--log-opts=--all --full-history']),
                            ('worktree', ['dir', str(stage)])]:
            report = output / (scope + '.json')
            result = subprocess.run([str(executable), *args, '--no-banner', '--redact=100',
                '--max-decode-depth=3', '--max-archive-depth=2', '--report-format=json',
                '--report-path=' + str(report)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if result.returncode not in (0, 1):
                raise RuntimeError('scanner failed for ' + scope + '; no clean claim made')
            compact = sanitize_scan_report(report)
            write_report(output / (scope + '-locations.json'), compact)
            summaries[scope] = {'findings': len(compact), 'exitCode': result.returncode}
    value = {'tool': 'gitleaks', 'version': version, 'scopes': summaries,
             'head': git(root, 'rev-parse', 'HEAD').decode().strip(),
             'refs': git(root, 'show-ref').decode().splitlines(),
             'commits': int(git(root, 'rev-list', '--all', '--count')),
             'skipped': skipped,
             'limitations': ['No remote-only refs, reflogs or unreachable objects inspected.',
                 'No OCR of screenshots/PDF; binary and license review remain separate.',
                 'No secret validity checks or credential rotation performed.',
                 'Pattern scanning cannot prove absence of every possible secret.']}
    write_report(output / 'summary.json', value)
    return value


def exclusion(name, policy):
    if name in policy.get('excludePaths', []):
        return 'retired-private-environment-tool-or-record'
    for prefix, reason in policy['excludePrefixes'].items():
        if name == prefix.rstrip('/') or name.startswith(prefix):
            return reason
    for suffix in policy['excludeSuffixes']:
        if name.lower().endswith(suffix):
            return 'binary-or-private-artifact-not-reviewed-for-public-source'
    for pattern in policy.get('excludePatterns', []):
        if re.search(pattern, name):
            return 'historical-device-specific-material'
    if any(part in {'.git', '.runtime', 'node_modules', '__pycache__'} for part in PurePosixPath(name).parts):
        return 'private-or-generated-directory'
    if Path(name).name.startswith('.env') and not name.endswith('.example'):
        return 'environment-secrets'
    return None


def export(root, output, policy_path, executable):
    scanner_version(executable)
    output = Path(output).absolute()
    if output.exists() or any(p.is_symlink() for p in output.parents):
        raise ValueError('export needs a new non-symlink output directory')
    policy = json.loads(Path(policy_path).read_text())
    for required in ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'docs/open-source/components.json']:
        if not (root / required).is_file() or exclusion(required, policy):
            raise ValueError('mandatory license/release document missing: ' + required)
    tracked = set(git(root, 'ls-files', '-z').decode().split('\0'))
    admitted = set(policy['untrackedFiles'])
    excluded, rows = [], []
    output.mkdir(parents=True, mode=0o700)
    for name in files(root):
        reason = exclusion(name, policy)
        if name not in tracked and name not in admitted:
            reason = 'untracked-input-not-explicitly-approved'
        if reason:
            excluded.append({'path': name, 'reason': reason})
            continue
        source = safe_source(root, name)
        if not source.is_file():
            continue
        content = source.read_bytes()
        try:
            content.decode('utf-8')
            opaque = b'\x00' in content
        except UnicodeDecodeError:
            opaque = True
        if opaque:
            excluded.append({'path': name, 'reason': 'opaque-binary-not-admitted-to-source-release'})
            continue
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(0o755 if os.access(source, os.X_OK) else 0o644)
        rows.append({'path': name, 'sha256': sha(target.read_bytes())})
    # The public report deliberately omits private excluded filenames/commit data.
    result = subprocess.run([str(executable), 'dir', str(output), '--no-banner', '--redact=100',
        '--max-decode-depth=3', '--max-archive-depth=2', '--report-format=json',
        '--report-path=' + str(output.parent / (output.name + '-scan.json'))],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode not in (0, 1):
        raise RuntimeError('candidate scan failed; candidate is NOT public-ready')
    sanitize_scan_report(output.parent / (output.name + '-scan.json'))
    value = {'candidate': True, 'published': False, 'sourceCommit': git(root, 'rev-parse', 'HEAD').decode().strip(),
             'dirtyPatchSha256': sha(git(root, 'diff', 'HEAD', '--binary')),
             'files': rows, 'exclusions': excluded, 'scanExitCode': result.returncode,
             'publicReady': False,
             'note': 'Requires redacted findings adjudication and license review; never auto-publishes.'}
    write_report(output.parent / (output.name + '-inventory.json'), value)
    return {'files': len(rows), 'excluded': len(excluded), 'scanExitCode': result.returncode,
            'output': str(output), 'published': False}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['baseline', 'scan', 'export'])
    p.add_argument('--root', type=Path, default=ROOT)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--gitleaks', type=Path)
    p.add_argument('--policy', type=Path, default=ROOT / 'docs/open-source/release-policy.json')
    a = p.parse_args()
    if a.command == 'baseline':
        write_report(a.output, baseline(a.root))
        print('baseline recorded (no content values printed)')
    elif a.command == 'scan':
        v = scan(a.root, a.gitleaks.resolve(), a.output)
        print(json.dumps({'version': v['version'], 'commits': v['commits'], 'scopes': v['scopes']}))
    else:
        print(json.dumps(export(a.root, a.output, a.policy, a.gitleaks.resolve())))
