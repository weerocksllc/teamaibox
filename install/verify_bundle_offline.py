#!/usr/bin/env python3
"""Import a complete package into a fresh, network-isolated Docker daemon.

This is packaging acceptance, not a full DGX installation. No host service is
restarted, no GPU is used and no customer volume or container is inspected.
The output directory retains imported test images and a report for inspection.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import uuid

from offline_common import atomic, need, run, verify_package, write_json
from installer import import_images


def verify(package, output):
    package, output = package.resolve(strict=True), output.absolute()
    need(os.geteuid() == 0, 'root is required for an isolated engine/network namespace')
    need(not output.exists() and not any(p.is_symlink() for p in (output, *output.parents)),
         'choose a new dedicated output directory')
    manifest = verify_package(package)
    unique = {r['imageId']: r for r in manifest['images']}
    parent = output.parent
    while not parent.exists():
        parent = parent.parent
    need(shutil.disk_usage(parent).free > sum(r['unpackedBytes'] for r in unique.values()) * 2 + 4 * 1024**3,
         'insufficient isolated-import workspace')
    for name in ('unshare', 'dockerd', 'docker'):
        need(shutil.which(name), 'packaging verification tool missing: ' + name)
    # Fail before creating the workspace if namespaces are unavailable.
    run(['unshare', '--net', '--', '/bin/true'])
    output.mkdir(parents=True, mode=0o700)
    atomic(output / 'daemon.json', b'{}\n')
    endpoint = 'unix://' + str(output / 'engine.sock')
    namespace = 'teamaibox-package-' + str(uuid.uuid4())
    command = ['unshare', '--net', '--', 'dockerd', '--config-file=' + str(output / 'daemon.json'),
        '--host=' + endpoint, '--data-root=' + str(output / 'data'), '--exec-root=' + str(output / 'exec'),
        '--pidfile=' + str(output / 'daemon.pid'), '--bridge=none', '--iptables=false', '--ip6tables=false',
        '--ip-forward=false', '--ip-masq=false', '--userland-proxy=false', '--storage-driver=overlay2',
        '--containerd-namespace=' + namespace, '--containerd-plugins-namespace=' + namespace + '-plugins']
    environment = {k: v for k, v in os.environ.items() if not k.lower().endswith('_proxy')}
    report = dict(status='incomplete', releaseId=manifest['releaseId'], candidate=manifest.get('candidate', False),
        imageRoles=len(manifest['images']), uniqueImages=len(unique), assetRoles=len(manifest['assets']),
        network='isolated-network-namespace', hostServicesChanged=False, customerDataAccessed=False,
        fullApplianceInstallationValidated=False, workspace=str(output))
    client_keys = ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_CONFIG')
    old_client = {key: os.environ.get(key) for key in client_keys}
    with (output / 'daemon.log').open('xb') as log:
        child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=environment)
        try:
            for key in client_keys:
                os.environ.pop(key, None)
            (output / 'client').mkdir(mode=0o700)
            os.environ.update(DOCKER_HOST=endpoint, DOCKER_CONFIG=str(output / 'client'))
            deadline = time.monotonic() + 60
            while True:
                need(child.poll() is None, 'isolated engine exited; see daemon.log')
                probe = subprocess.run(['docker', 'info', '--format', '{{.DockerRootDir}}'], capture_output=True, text=True, timeout=5)
                if probe.returncode == 0:
                    need(probe.stdout.strip() == str(output / 'data'), 'wrong Docker data root')
                    break
                need(time.monotonic() < deadline, 'isolated engine startup timed out')
                time.sleep(0.5)
            need(not run(['docker', 'image', 'ls', '-q']).strip(), 'isolated engine was not empty')
            host_network = os.readlink('/proc/self/ns/net')
            pid = int((output / 'daemon.pid').read_text().strip())
            need(os.readlink('/proc/' + str(pid) + '/ns/net') != host_network, 'engine network namespace is not isolated')
            report['emptyEngineVerified'] = True
            write_json(output / 'report.json', report)
            def progress(args, **kwargs):
                if args[:3] == ['docker', 'image', 'load']:
                    print('Offline import: ' + Path(args[-1]).name, flush=True)
                return run(args, **kwargs)
            import_images(manifest, package, runner=progress)
            imported = json.loads(run(['docker', 'image', 'inspect', *sorted(unique)], timeout=120))
            need({r['Id'] for r in imported} == set(unique) and all(r['Architecture'] == 'arm64' and r['Os'] == 'linux'
                for r in imported), 'imported image identities differ')
            report.update(status='passed', importedImageIds=sorted(unique), pullUsed=False,
                          packageIntegrityVerified=True, importedFromPackageOnly=True)
        finally:
            for key, previous in old_client.items():
                if previous is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = previous
            # Only this child engine is stopped, never the system Docker unit.
            child.terminate()
            try:
                child.wait(timeout=45)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait(timeout=10)
            report['isolatedDaemonStopped'] = child.poll() is not None
            write_json(output / 'report.json', report, 0o644)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.package, args.output), indent=2))
