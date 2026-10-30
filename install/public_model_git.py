"""Authenticate mirror model metadata using the repository-pinned Git commit.

No mirror-provided API hash is trusted. Git verifies objects; the commit pins
the tree, which pins each LFS pointer, which pins the weight SHA-256 and size.
Only Git objects are fetched, never LFS weights or checkout hooks.
"""
import hashlib
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit
from offline_common import need


def endpoint(value):
    p = urlsplit(value)
    need(p.scheme == 'https' and p.hostname and not p.username and not p.password
         and not p.query and not p.fragment and p.path in ('', '/'),
         'model endpoint must be an HTTPS origin without credentials or path')
    return value.rstrip('/')


def pointer(raw, blob, size):
    if raw.startswith(b'version https://git-lfs.github.com/spec/v1\n'):
        match = re.fullmatch(rb'version https://git-lfs.github.com/spec/v1\noid sha256:([a-f0-9]{64})\nsize ([0-9]+)\n?', raw)
        need(match is not None, 'invalid pinned LFS pointer')
        return dict(size=int(match[2]), blobId=blob,
                    lfs=dict(sha256=match[1].decode(), size=int(match[2])))
    return dict(size=size, blobId=blob)


def metadata(repo, revision, origin, cache):
    origin = endpoint(origin)
    need(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo), 'invalid model repository')
    need(re.fullmatch(r'[a-f0-9]{40}', revision), 'model revision must be a pinned commit')
    directory = Path(cache) / hashlib.sha256(repo.encode()).hexdigest()
    directory.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
           'GIT_TERMINAL_PROMPT': '0', 'GIT_LFS_SKIP_SMUDGE': '1'}
    def git(*args, check=True):
        return subprocess.run(['git', '-c', 'safe.directory='+str(directory),
            '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
            '-c', 'http.sslVerify=true', '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true',
            '-C', str(directory), *args], env=env, check=check, capture_output=True, timeout=300)
    if not (directory / 'HEAD').exists():
        git('init', '--bare')
    if git('cat-file', '-e', revision+'^{commit}', check=False).returncode:
        git('fetch', '--depth=1', '--no-tags', origin+'/'+repo, revision)
    need(git('rev-parse', revision+'^{commit}').stdout.decode().strip() == revision, 'wrong model commit')
    git('fsck', '--strict', '--no-reflogs', revision)
    records = []
    for row in git('ls-tree', '-rlz', revision).stdout.split(b'\0'):
        if not row:
            continue
        head, name = row.split(b'\t', 1)
        mode, kind, blob, size = head.split()
        need(kind == b'blob' and mode in (b'100644', b'100755'), 'unsupported model tree entry')
        size = int(size)
        raw = git('cat-file', 'blob', blob.decode()).stdout if size <= 1024 else b''
        records.append(dict(rfilename=name.decode(), **pointer(raw, blob.decode(), size)))
    return dict(sha=revision, siblings=records)
