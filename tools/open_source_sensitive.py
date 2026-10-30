#!/usr/bin/env python3
"""Supplement Gitleaks with low-entropy literals, paths and commit-message review.

Outputs only locations, fingerprints and classifications; never secret values.
Reads local Git objects only, without contacting remotes or validating credentials.
"""
import hashlib
from bisect import bisect_right
import json
from pathlib import Path
import re
import subprocess

LITERAL = re.compile(r'''(?im)\b(?:[\w-]{0,80}(?:password|passwd|secret|token|api_key))["']?\s*[:=]\s*["']([^"'\r\n]{4,300})["']''')
AUTH_URL = re.compile(r'https?://[^\s/:@]+:[^\s/@]+@')
PRIVATE_KEY = re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
PRIVATE_PATH = re.compile(r'/Users/[^/\s]+/|/home/[^/\s]+/|\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b')
PHONE_IDENTITY = re.compile(r'\bteamaibox-phone-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b', re.I)
GSF_HASH = re.compile(r'''(?i)gsfIdSha256[^\r\n]{0,80}?["']([0-9a-f]{64})["']''')
LOGIN_LITERAL = re.compile(r'''(?im)\b(?:TEST_LOGIN|loginName|normalizedLoginName|username)["']?\s*[:=]\s*["']([^"'\r\n]{2,120})["']''')
INSTANCE_ID = re.compile(r'\b(?:pool|phone|computer|container)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b', re.I)
UUID_LITERAL = re.compile(r'\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b', re.I)


def load_denied_markers(path):
    """A private, external list of confirmed old values; never commit this file.

    Labels must be opaque, non-sensitive review identifiers. Exact values are
    held in memory only and are never included in reports or error messages.
    """
    if path is None:
        return []
    try:
        rows = json.loads(Path(path).read_text())
        if not isinstance(rows, list):
            raise ValueError()
        result = []
        for row in rows:
            if (not isinstance(row, dict) or set(row) - {'id', 'value', 'word'}
                    or not re.fullmatch(r'[a-z][a-z0-9_-]{0,79}', row.get('id', ''))
                    or not isinstance(row.get('value'), str)
                    or not 3 <= len(row['value']) <= 4096
                    or not isinstance(row.get('word', False), bool)):
                raise ValueError()
            expression = re.escape(row['value'])
            if row.get('word', False):
                expression = r'(?<![\w-])' + expression + r'(?![\w-])'
            result.append((row['id'], re.compile(expression)))
        return result
    except (OSError, ValueError, TypeError):
        raise ValueError('Private marker list is invalid; values were not logged') from None


def inspect(data, path, object_id=None, scope='worktree', denied=()):
    if b'\x00' in data:
        return [], {'path': path, 'object': object_id, 'reason': 'binary-not-text-scanned'}
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return [], {'path': path, 'object': object_id, 'reason': 'non-utf8-not-text-scanned'}
    rows = []
    newlines = [m.start() for m in re.finditer('\n', text)]
    patterns = [('credential-literal', LITERAL), ('credential-url', AUTH_URL),
                ('private-key', PRIVATE_KEY), ('private-environment-reference', PRIVATE_PATH),
                ('embedded-phone-identity', PHONE_IDENTITY), ('embedded-gsf-hash', GSF_HASH),
                ('login-literal', LOGIN_LITERAL), ('embedded-instance-identity', INSTANCE_ID),
                ('uuid-literal', UUID_LITERAL)]
    patterns.extend(('known-private-marker:' + label, pattern) for label, pattern in denied)
    for rule, pattern in patterns:
        for match in pattern.finditer(text):
            value = match.group(1) if rule == 'credential-literal' else match.group()
            classification = 'review-required'
            if rule == 'private-environment-reference':
                classification = 'environment-reference-not-credential'
            elif rule in {'embedded-phone-identity', 'embedded-gsf-hash', 'embedded-instance-identity', 'uuid-literal'}:
                classification = 'device-metadata-review-context-not-login-credential'
            elif rule.startswith('known-private-marker:'):
                classification = 'confirmed-private-marker-must-not-publish'
            elif rule == 'credential-literal' and (value in {'admin', 'change-me', 'changeme', 'test-secret', 'test-token', 'password'} or value.startswith(('example-', 'test-', 'synthetic-', '${', 'process.env.', 'os.environ'))):
                classification = 'default-or-placeholder-review-context'
            rows.append({'scope': scope, 'rule': rule, 'path': path, 'object': object_id,
                         'line': bisect_right(newlines, match.start()) + 1,
                         'fingerprint': hashlib.sha256((path+'\0'+rule+'\0'+value).encode()).hexdigest(),
                         'classification': classification})
    return rows, None


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def history(root, denied=()):
    objects = git(root, 'rev-list', '--objects', '--all').decode().splitlines()
    process = subprocess.Popen(['git', '-C', str(root), 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    rows, skipped, types = [], [], {}
    try:
        for entry in objects:
            oid, _, path = entry.partition(' ')
            process.stdin.write((oid+'\n').encode()); process.stdin.flush()
            header = process.stdout.readline().split()
            if len(header) != 3:
                raise RuntimeError('Git object read failed')
            kind, size = header[1].decode(), int(header[2])
            data = process.stdout.read(size); process.stdout.read(1)
            types[kind] = types.get(kind, 0) + 1
            if kind not in {'blob', 'commit', 'tag'}:
                continue
            # Commit/tag messages are included, not only diffs.
            found, skip = inspect(data, path or ('<'+kind+'>'), oid, 'history', denied)
            rows.extend(found)
            if skip:
                skipped.append(skip)
    finally:
        process.stdin.close(); process.stdout.close(); process.wait()
    return {'findings': rows, 'skipped': skipped, 'objectTypes': types,
            'limitations': ['reachable local refs only; no remote-only refs/reflogs/unreachable objects', 'no OCR, binary decoding, secret validity checks or credential rotation']}


if __name__ == '__main__':
    import argparse
    from open_source_release import files, safe_source, write_report
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--denylist', type=Path, help='Private external confirmed-marker JSON; never included in reports')
    p.add_argument('--scope', choices=['all', 'history', 'worktree'], default='all')
    a = p.parse_args()
    denied = load_denied_markers(a.denylist)
    result = history(a.root, denied) if a.scope != 'worktree' else {
        'findings': [], 'skipped': [], 'objectTypes': {},
        'limitations': ['worktree-only; no claim about existing Git history']}
    current, skips = [], []
    for name in files(a.root) if a.scope != 'history' else []:
        path = safe_source(a.root, name)
        if path.is_file():
            found, skip = inspect(path.read_bytes(), name, denied=denied)
            current.extend(found)
            if skip:
                skips.append(skip)
    result['worktree'] = {'findings': current, 'skipped': skips}
    result['knownMarkerCount'] = len(denied)
    result['knownMarkerFindings'] = sum(row['rule'].startswith('known-private-marker:')
        for row in result['findings'] + current)
    write_report(a.output, result)
    print(json.dumps({'objectTypes': result['objectTypes'], 'historicalFindings': len(result['findings']), 'worktreeFindings': len(current), 'binaryOrEncodingBlindSpots': len(result['skipped']), 'knownMarkerFindings': result['knownMarkerFindings']}))
    raise SystemExit(1 if result['knownMarkerFindings'] else 0)
