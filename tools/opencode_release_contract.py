"""Public, deterministic source identity helpers; never reads host credentials."""
from __future__ import annotations
import gzip
import hashlib
import json
import os
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {'.git', 'node_modules', '__pycache__', 'dist', '.cache', '.runtime', '.venv'}

def digest_bytes(value: bytes) -> str:
    return 'sha256:' + hashlib.sha256(value).hexdigest()

def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()

def source_files(paths, root=ROOT):
    root = Path(root).resolve()
    files = {}
    for relative in paths:
        p = Path(relative)
        if p.is_absolute() or '..' in p.parts:
            raise ValueError('source path must stay inside checkout')
        target = root / p
        if target.is_symlink() or not target.exists():
            raise ValueError('source path missing or symlink: ' + relative)
        candidates = [target] if target.is_file() else []
        if target.is_dir():
            for directory, folders, names in os.walk(target, followlinks=False):
                if any((Path(directory) / name).is_symlink() for name in folders):
                    raise ValueError('source must not contain directory symlinks')
                folders[:] = sorted(n for n in folders if n not in EXCLUDED)
                for name in sorted(names):
                    file = Path(directory) / name
                    if file.suffix not in {'.pyc', '.tsbuildinfo'}:
                        candidates.append(file)
        for file in candidates:
            if file.is_symlink() or not file.resolve().is_relative_to(root):
                raise ValueError('source must not contain symlinks or escapes')
            files[file.relative_to(root).as_posix()] = file
    return dict(sorted(files.items()))

def source_identity(paths, root=ROOT):
    manifest = {name: digest_bytes(path.read_bytes()) for name, path in source_files(paths, root).items()}
    return {'digest': digest_bytes(canonical(manifest)), 'fileCount': len(manifest)}

def _create_source_archive(paths, output, root=ROOT):
    """Compatibility helper for historical validators, with public-only inputs."""
    files = source_files(paths, root)
    with Path(output).open('xb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode='w') as archive:
                for name, file in files.items():
                    info = archive.gettarinfo(str(file), arcname=name)
                    info.uid = info.gid = 0
                    info.uname = info.gname = ''
                    info.mtime = 0
                    with file.open('rb') as content:
                        archive.addfile(info, content)
    return digest_bytes(Path(output).read_bytes()), len(files)
