#!/usr/bin/env python3
"""Fetch a public, digest-pinned ARM64 OCI image without installing host tools."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import time

ACCEPT = 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'


def digest(raw):
    return 'sha256:'+hashlib.sha256(raw).hexdigest()


def fetch(url, path):
    # This utility only reads public registry artifacts. No credentials or TLS bypass.
    result = subprocess.run(['curl', '-fLsS', '--retry', '2', '--connect-timeout', '15',
                             '--max-time', '900', '--speed-limit', '1024', '--speed-time', '60',
                             '-H', 'Accept: '+ACCEPT, '-o', str(path), url], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr[-1000:])


def hashfile(path):
    sha = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            sha.update(block)
    return 'sha256:'+sha.hexdigest()


def run(args):
    if args.registry != 'us-docker.pkg.dev' or not args.repository.startswith('android-cuttlefish-artifacts/'):
        raise ValueError('registry outside current lab scope')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', args.digest):
        raise ValueError('an exact manifest digest is required')
    root = Path(args.output)
    root.mkdir(parents=True, exist_ok=False)
    blobdir = root/'blobs/sha256'
    blobdir.mkdir(parents=True)
    url = 'https://'+args.registry+'/v2/'+args.repository
    manifest_path = blobdir/args.digest.split(':')[1]
    fetch(url+'/manifests/'+args.digest, manifest_path)
    if hashfile(manifest_path) != args.digest:
        raise ValueError('manifest digest mismatch')
    manifest = json.loads(manifest_path.read_bytes())
    report = {'manifestDigest': args.digest, 'repository': args.repository, 'registry': args.registry,
              'startedUnix': time.time(), 'artifacts': []}
    for descriptor in [manifest['config'], *manifest['layers']]:
        target = blobdir/descriptor['digest'].split(':')[1]
        if target.exists():
            continue
        print(json.dumps({'fetching': descriptor['digest'], 'bytes': descriptor['size']}), flush=True)
        fetch(url+'/blobs/'+descriptor['digest'], target)
        if hashfile(target) != descriptor['digest'] or target.stat().st_size != descriptor['size']:
            raise ValueError('blob digest/size mismatch')
        report['artifacts'].append(descriptor)
    config = json.loads((blobdir/manifest['config']['digest'].split(':')[1]).read_bytes())
    if config['architecture'] != 'arm64':
        raise ValueError('image is not ARM64')
    report['configDigest'] = manifest['config']['digest']
    report['architecture'] = config['architecture']
    report['finishedUnix'] = time.time()
    (root/'oci-layout').write_text('{"imageLayoutVersion":"1.0.0"}\n')
    (root/'index.json').write_text(json.dumps({'schemaVersion': 2, 'manifests': [{
        'mediaType': manifest['mediaType'], 'digest': args.digest, 'size': manifest_path.stat().st_size,
        'platform': {'os': 'linux', 'architecture': 'arm64'},
        'annotations': {'org.opencontainers.image.ref.name': 'teamaibox/android-lab-cuttlefish:20260911-a1'}}]}))
    (root/'result.json').write_text(json.dumps(report, indent=2)+'\n')
    with tarfile.open(str(root)+'.tar', 'x') as archive:
        for name in ('oci-layout', 'index.json', 'blobs'):
            archive.add(root/name, arcname=name)
    print(json.dumps({'archive': str(root)+'.tar', 'archiveSha256': hashfile(Path(str(root)+'.tar'))}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registry', required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--digest', required=True)
    parser.add_argument('--output', required=True)
    run(parser.parse_args())
