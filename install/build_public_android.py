#!/usr/bin/env python3
"""Build the AOSP base/network runtime from public inputs, without guest state.

This builds the base runtime, not the camera-enabled full factory image. Its
report explicitly distinguishes that stage from the complete product pipeline.
Downloaded archives are retained outside the source tree and SHA-256 verified.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import uuid

from offline_common import digest, need, read_json, run, write_json


def acquire(url, expected, destination, opener=urllib.request.urlopen):
    if opener is urllib.request.urlopen:
        from source_download import download
        return download(url, expected, destination)
    destination = Path(destination)
    need(url.startswith('https://'), 'public input requires HTTPS')
    need(not destination.is_symlink(), 'input cache must not be a symlink')
    if destination.exists():
        need(destination.is_file() and digest(destination) == expected, 'cached input checksum mismatch: ' + destination.name)
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.download-', delete=False) as stream:
        partial = Path(stream.name)
        try:
            with opener(url, timeout=120) as source:
                need(source.geturl().startswith('https://'), 'input redirected outside HTTPS')
                shutil.copyfileobj(source, stream, 1024 * 1024)
            stream.flush()
            need(digest(partial) == expected, 'download checksum mismatch: ' + destination.name)
            partial.replace(destination)
        finally:
            partial.unlink(missing_ok=True)
    return destination


def build(repository, cache, output, dependencies_only=False):
    repository, cache, output = repository.resolve(), cache.absolute(), output.absolute()
    need(not output.exists(), 'use a new output directory')
    source = repository / 'deploy/android/cuttlefish'
    lock = read_json(source / 'inputs.lock.json')
    output.mkdir(parents=True)
    prefix = 'teamaibox-public-android:' + uuid.uuid4().hex
    report = dict(status='building', completeFactoryRuntime=False, images={}, inputs={},
                  sourceCommit=run(['git', '-C', repository, 'rev-parse', 'HEAD']).strip(),
                  candidate=bool(run(['git', '-C', repository, 'status', '--porcelain']).strip()),
                  deployed=False, importedGuestState=False)

    def stage(name, dockerfile, context, arguments=(), online=False):
        tag = prefix + '-' + name
        command = ['docker', 'build', '--platform=linux/arm64', '--pull=' + str(online).lower(),
                   '--network=' + ('default' if online else 'none'), '-f', str(dockerfile), '-t', tag]
        for key, value in arguments:
            command += ['--build-arg', key + '=' + value]
        with (output / (name + '.log')).open('xb') as log:
            result = subprocess.run([*command, str(context)], stdout=log, stderr=subprocess.STDOUT)
        need(result.returncode == 0, 'build failed: ' + str(output / (name + '.log')))
        image = json.loads(run(['docker', 'image', 'inspect', tag]))[0]
        need(image['Architecture'] == 'arm64' and image['Os'] == 'linux', 'wrong build architecture')
        report['images'][name] = dict(reference=tag, imageId=image['Id'])
        write_json(output / 'build.json', report)
        return tag

    base = stage('dependencies', source / 'Dependencies.Dockerfile', source, online=True)
    if not dependencies_only:
        for name, expected in lock['inputs'].items():
            need(Path(name).name == name, 'unsafe input filename')
            url = ('https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js'
                   if name == 'jquery-3.6.0.min.js' else lock['artifactBaseUrl'] + name)
            acquire(url, expected, cache / name)
            report['inputs'][name] = dict(url=url, sha256=expected)
        with tempfile.TemporaryDirectory(prefix='teamaibox-android-context-', dir=output) as temporary:
            context = Path(temporary)
            # Explicit inputs only; never copy runtime data or the developer's tree.
            for path in source.iterdir():
                if path.is_file() and (path.suffix in ('.py', '.json') or path.name.endswith('Dockerfile')):
                    shutil.copyfile(path, context / path.name)
            shutil.copyfile(repository / 'tools/android_lab_cuttlefish_capability_query.py', context / 'capability_query.py')
            shutil.copyfile(repository / 'services/media_io/resources.py', context / 'resources.py')
            (context / 'inputs').mkdir()
            for name in lock['inputs']:
                shutil.copyfile(cache / name, context / 'inputs' / name)
            bundle = stage('bundle', context / 'Dockerfile', context, [('DEPENDENCY_IMAGE', base)])
            runtime = stage('runtime', context / 'Runtime.Dockerfile', context, [('BUNDLE_IMAGE', bundle)])
            stage('network', context / 'Network.Dockerfile', context, [('RUNTIME_IMAGE', runtime)])
    report['status'] = 'dependencies-built' if dependencies_only else 'base-runtime-built'
    write_json(output / 'build.json', report, 0o644)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--dependencies-only', action='store_true')
    args = parser.parse_args()
    print(json.dumps(build(args.repository, args.cache, args.output, args.dependencies_only), indent=2))
