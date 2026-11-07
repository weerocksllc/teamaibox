#!/usr/bin/env python3
"""Prepare verified Penpot source outside the checkout; never installs services."""
import argparse
import fcntl
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
from offline_common import need, read_json
from source_download import download, file_hash


def extract_source(archive, destination, prefix):
    """Extract regular source files and safe sibling links into a NEW directory."""
    destination = Path(destination)
    need(not destination.exists(), 'source destination already exists')
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        names = set()
        for member in members:
            p = PurePosixPath(member.name)
            need(not p.is_absolute() and '..' not in p.parts and p.parts[0] == prefix,
                 'unsafe source archive path')
            need(member.name not in names, 'duplicate source archive entry')
            names.add(member.name)
            need(member.isdir() or member.isfile() or member.issym(), 'unsupported archive entry')
            if member.issym():
                link = PurePosixPath(member.linkname)
                need(len(link.parts) == 1 and member.linkname not in ('', '.', '..')
                     and not link.is_absolute(), 'unsafe source link')
        links = {m.name for m in members if m.issym()}
        for member in members:
            need(not any(str(p) in links for p in PurePosixPath(member.name).parents),
                 'archive member traverses link')
        destination.mkdir()
        # Never restore archive ownership, setuid bits, devices or hard links.
        for member in members:
            path = destination.joinpath(*PurePosixPath(member.name).parts[1:])
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                path.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, path.open('xb') as target:
                    shutil.copyfileobj(source, target)
                path.chmod(0o755 if member.mode & 0o111 else 0o644)
        for member in members:
            if member.issym():
                path = destination.joinpath(*PurePosixPath(member.name).parts[1:])
                need(path.with_name(member.linkname).is_file(), 'source link target missing')
                path.symlink_to(member.linkname)


def prepare(repository, cache, output, archive=None):
    repository, cache, output = map(Path, (repository, cache, output))
    need(not output.exists(), 'use a new source output directory; existing data is never replaced')
    for path in (cache, output):
        need(not any(p.is_symlink() for p in (path, *path.parents)), 'symlink in preparation path')
    need(not output.resolve().is_relative_to(repository.resolve()), 'source output must be outside checkout')
    need(not cache.resolve().is_relative_to(repository.resolve()), 'download cache must be outside checkout')
    lock = read_json(repository / 'deploy/penpot-source.lock.json')
    cache.mkdir(parents=True, exist_ok=True)
    fd = os.open(cache / '.penpot-source.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lease:
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Penpot source preparation is already running') from None
        archive = Path(archive) if archive else download(
            lock['archiveUrl'], lock['archiveSha256'], cache / (lock['commit'] + '.tar.gz'))
        need(file_hash(archive) == lock['archiveSha256'], 'Penpot source archive checksum mismatch')
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='penpot-source-', dir=output.parent) as stage:
            source = Path(stage) / 'source'
            extract_source(archive, source, 'penpot-' + lock['commit'])
            for relative, expected in lock['contractFiles'].items():
                need(file_hash(source / relative) == expected, 'Penpot contract checksum mismatch: ' + relative)
            need(not output.exists(), 'source output appeared during preparation')
            source.rename(output)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--archive', type=Path, help='reuse a local archive after full pinned verification')
    args = parser.parse_args()
    print(prepare(args.repository, args.cache, args.output, args.archive))
