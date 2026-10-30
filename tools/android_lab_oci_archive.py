#!/usr/bin/env python3
"""Convert verified OCI blobs to Docker load format, without extracting image paths."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import tempfile


def blob(root, value):
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', value):
        raise ValueError('invalid blob digest')
    path = root/'blobs/sha256'/value[7:]
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != value[7:]:
        raise ValueError('blob digest mismatch')
    return path


def convert(root, target, tag):
    index = json.loads((root/'index.json').read_text())
    if len(index['manifests']) != 1:
        raise ValueError('expected one pinned platform manifest')
    manifest = json.loads(blob(root, index['manifests'][0]['digest']).read_text())
    cfg = blob(root, manifest['config']['digest'])
    config = json.loads(cfg.read_text())
    if config['architecture'] != 'arm64':
        raise ValueError('not an ARM64 image')
    layers = []
    with tarfile.open(target, 'x') as archive:
        archive.add(cfg, arcname=cfg.name+'.json')
        for n, entry in enumerate(manifest['layers']):
            compressed = blob(root, entry['digest'])
            # Never extract an untrusted member path: treat each layer as opaque bytes.
            with tempfile.TemporaryFile(dir=Path(target).parent) as tmp:
                sha = hashlib.sha256()
                opener = gzip.open if 'gzip' in entry['mediaType'] else open
                with opener(compressed, 'rb') as stream:
                    for chunk in iter(lambda: stream.read(1024*1024), b''):
                        tmp.write(chunk)
                        sha.update(chunk)
                if 'sha256:'+sha.hexdigest() != config['rootfs']['diff_ids'][n]:
                    raise ValueError('uncompressed layer digest mismatch')
                name = str(n)+'-'+sha.hexdigest()+'/layer.tar'
                info = tarfile.TarInfo(name)
                info.size = tmp.tell()
                tmp.seek(0)
                archive.addfile(info, tmp)
                layers.append(name)
        raw = json.dumps([{'Config': cfg.name+'.json', 'RepoTags': [tag], 'Layers': layers}]).encode()
        info = tarfile.TarInfo('manifest.json')
        info.size = len(raw)
        archive.addfile(info, io.BytesIO(raw))
    print(json.dumps({'imageId': manifest['config']['digest'], 'layers': len(layers), 'dockerArchive': str(target)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    convert(Path(args.source), args.output, args.tag)
