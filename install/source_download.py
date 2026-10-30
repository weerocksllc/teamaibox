"""Resumable HTTPS file cache; successful publication requires a pinned hash."""
import hashlib
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen
from offline_common import need


def file_hash(path, algorithm='sha256'):
    h = hashlib.new(algorithm)
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(4*1024**2), b''):
            h.update(chunk)
    return h.hexdigest()


def download(url, expected, destination, algorithm='sha256'):
    need(url.startswith('https://'), 'download requires HTTPS')
    need(algorithm in ('sha256', 'sha1') and re.fullmatch(
        '[a-f0-9]{'+('64' if algorithm == 'sha256' else '40')+'}', expected), 'invalid expected hash')
    destination = Path(destination)
    need(not any(p.is_symlink() for p in (destination, *destination.parents)), 'symlink in download path')
    if destination.exists():
        need(file_hash(destination, algorithm) == expected, 'cached file differs: '+destination.name)
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name+'.'+expected+'.partial')
    need(not partial.is_symlink(), 'symlink in partial download')
    if partial.exists() and file_hash(partial, algorithm) == expected:
        partial.replace(destination)
        return destination
    for attempt in range(3):
        offset = partial.stat().st_size if partial.exists() else 0
        try:
            request = Request(url, headers={'Range': 'bytes='+str(offset)+'-'} if offset else {})
            with urlopen(request, timeout=45) as response:
                need(response.geturl().startswith('https://'), 'insecure redirect')
                if response.status == 206:
                    need(response.headers.get('Content-Range', '').startswith('bytes '+str(offset)+'-'),
                         'wrong resume range')
                else:
                    need(response.status == 200, 'unexpected download response')
                    offset = 0  # A server without ranges can restart this file, not the build.
                with partial.open('ab' if offset else 'wb') as out:
                    for chunk in iter(lambda: response.read(1024**2), b''):
                        out.write(chunk)
            if file_hash(partial, algorithm) != expected:
                # Keep mismatched evidence, but never reuse it as a valid prefix.
                partial.rename(partial.with_name(partial.name+'.invalid-'+str(time.time_ns())))
                raise RuntimeError('download checksum mismatch: '+destination.name)
            partial.replace(destination)
            return destination
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt+1)
