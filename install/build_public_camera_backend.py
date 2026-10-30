#!/usr/bin/env python3
"""Build the camera host backend from pinned Google source and public Rust.

No phone is started; no installed host libraries, user data or Docker image IDs
are imported. The upstream crate lock is retained and the three reviewed source
adaptations are applied in order. This is one input to the full phone build.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import shutil
import subprocess
import sys
import uuid
from build_public_android import acquire
from offline_common import need, read_json, run, write_json

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from phone_camera_singleplane_adapter import adapt as singleplane
from phone_camera_socket_adapter import adapt as socket_transport
from phone_camera_clock_adapter import adapt as guest_clock


def build(cache, output, compiler=None):
    need(not output.exists(), 'use a new output directory')
    output.mkdir(parents=True)
    config = ROOT / 'deploy/android/cuttlefish'
    lock = read_json(config / 'camera-input/upstream.lock.json')
    upstream = cache / lock['commit']
    def download(item):
        name, checksum = item
        return name, acquire('https://raw.githubusercontent.com/google/android-cuttlefish/' +
            lock['commit'] + '/' + lock['directory'] + '/' + name, checksum, upstream / name)
    report = dict(status='building', deployed=False, completeFactoryRuntime=False)
    try:
        files = dict(ThreadPoolExecutor(max_workers=3).map(download, lock['files'].items()))
        package = acquire(lock['hostPackage']['url'], lock['hostPackage']['sha256'], cache / 'cuttlefish-base.deb')
        run(['dpkg-deb', '-x', package, output / 'host-package'])
        context = output / 'source'
        for name, path in files.items():
            text = guest_clock(name, socket_transport(name, singleplane(name, path.read_text())))
            if name == 'Cargo.toml':
                text = text.replace('    "emulated_camera_mplane",\n', '').replace('    "emulated_camera_splane",\n', '')
            target = context / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
        shutil.copyfile(config / 'camera-input/Cargo.lock', context / 'Cargo.lock')
        if compiler is None:
            compiler = 'teamaibox-public-camera-compiler:' + uuid.uuid4().hex
            with (output / 'compiler.log').open('xb') as log:
                result = subprocess.run(['docker', 'build', '--network=host', '--platform=linux/arm64',
                    '-f', str(config / 'PublicCameraCompiler.Dockerfile'), '-t', compiler, str(config)],
                    stdout=log, stderr=subprocess.STDOUT)
            need(result.returncode == 0, 'compiler build failed; see compiler.log')
        identity = json.loads(run(['docker', 'image', 'inspect', compiler]))[0]
        need(identity['Os'] == 'linux' and identity['Architecture'] == 'arm64', 'invalid compiler architecture')
        report['compiler'] = compiler
        report['compilerImageId'] = identity['Id']
        registry = cache / 'cargo-registry'
        registry.mkdir(exist_ok=True)
        with (output / 'backend.log').open('xb') as log:
            result = subprocess.run(['docker', 'run', '--rm', '--network=host',
                '--env', 'BINDGEN_EXTRA_CLANG_ARGS=-I/usr/include/aarch64-linux-gnu',
                '--mount', 'type=bind,src=' + str(context.resolve()) + ',dst=/work',
                '--mount', 'type=bind,src=' + str(registry.resolve()) + ',dst=/usr/local/cargo/registry',
                compiler, 'cargo', 'build', '--locked', '--release', '-p', 'v4l2_stream_proxy'],
                stdout=log, stderr=subprocess.STDOUT, timeout=2400)
        need(result.returncode == 0, 'backend build failed; see backend.log')
        executable = context / 'target/release/v4l2_stream_proxy'
        need(executable.is_file(), 'compiled backend missing')
        report.update(status='backend-built', backend=str(executable), hostPackage=str(output / 'host-package'))
    except Exception as error:
        report.update(status='failed', failure=str(error))
    write_json(output / 'build.json', report, 0o644)
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cache', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--compiler-image', help='reuse an image from a successful public compiler build')
    a = p.parse_args()
    result = build(a.cache.absolute(), a.output.absolute(), a.compiler_image)
    print(json.dumps(result, indent=2))
    raise SystemExit(result['status'] == 'failed')
