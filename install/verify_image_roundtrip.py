#!/usr/bin/env python3
"""Installation-only save/load probe in a new isolated Docker daemon.

Reads one explicitly named small image from the existing daemon. Never changes
that daemon's images, containers, networks, settings or services. Leaves a
bounded report directory and stops only the child daemon it started.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time


def command(args, **options):
    result = subprocess.run(args, check=True, timeout=options.pop('timeout', 120),
                            stderr=subprocess.PIPE, **options)
    return result.stdout


def migration_probe(dest, image_id, up, down):
    """Exercise only the new constraints in an empty, networkless test DB."""
    command([*dest, 'run', '-d', '--name=offline-migration-probe', '--pull=never', '--network=none',
             '--user=999:999', '--memory=256m', '--pids-limit=128',
             '--tmpfs=/var/lib/postgresql:rw,uid=999,gid=999,mode=0700,size=128m',
             '--tmpfs=/var/run/postgresql:rw,uid=999,gid=999,mode=0700,size=16m',
             '-e', 'PGDATA=/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
             '-e', 'POSTGRES_USER=installer_test', '-e', 'POSTGRES_DB=installer_test',
             '--entrypoint=docker-entrypoint.sh', image_id, 'postgres', '-c', 'max_connections=10',
             '-c', 'shared_buffers=16MB'], stdout=subprocess.PIPE)
    psql = [*dest, 'exec', '-i', 'offline-migration-probe', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
            '-U', 'installer_test', '-d', 'installer_test', '--single-transaction', '-f', '-']
    deadline = time.monotonic() + 45
    while True:
        ready = subprocess.run([*dest, 'exec', 'offline-migration-probe', 'pg_isready', '-U', 'installer_test'],
                               capture_output=True, timeout=3)
        if ready.returncode == 0:
            break
        if time.monotonic() > deadline:
            raise RuntimeError('isolated migration database did not start')
        time.sleep(0.5)
    def sql(source):
        return command(psql, input=source, text=True, stdout=subprocess.PIPE)
    legacy = 'registry.local/test@sha256:' + 'a' * 64
    local = 'sha256:' + 'b' * 64
    sql("CREATE SCHEMA compute; CREATE SCHEMA platform;"
        "CREATE TABLE compute.worker_instances (image_reference text CHECK(image_reference ~ '^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$'));"
        "CREATE TABLE platform.agent_sandboxes (image_reference text CHECK(image_reference ~ '^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$'));"
        f"INSERT INTO compute.worker_instances VALUES ('{legacy}');")
    sql(up)
    sql(f"INSERT INTO compute.worker_instances VALUES ('{local}'); INSERT INTO platform.agent_sandboxes VALUES ('{local}');")
    rejected = subprocess.run(psql, input="INSERT INTO compute.worker_instances VALUES ('worker:latest');", text=True,
                              capture_output=True, timeout=10)
    if rejected.returncode == 0:
        raise RuntimeError('mutable image tag was accepted')
    downgrade = subprocess.run(psql, input=down, text=True, capture_output=True, timeout=10)
    if downgrade.returncode == 0:
        raise RuntimeError('unsafe downgrade was accepted')
    if sql('SELECT count(*) FROM compute.worker_instances; SELECT count(*) FROM platform.agent_sandboxes;').split() != ['2', '1']:
        raise RuntimeError('migration or refused downgrade changed fixture rows')
    sql("DELETE FROM compute.worker_instances WHERE image_reference ~ '^sha256:'; DELETE FROM platform.agent_sandboxes;")
    sql(down)
    if sql('SELECT image_reference FROM compute.worker_instances;').strip() != legacy:
        raise RuntimeError('legacy reference changed')
    command([*dest, 'rm', '-f', '-v', 'offline-migration-probe'], stdout=subprocess.PIPE)
    return dict(newContentIdsAccepted=True, mutableTagsRejected=True, unsafeDowngradeRefused=True,
                legacyRowsPreserved=True, databaseWasNew=True, network='none')


def probe(image_id, migration=None):
    if os.geteuid() or not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id):
        raise ValueError('root and an explicit full image ID are required')
    source = ['docker', '--host', 'unix:///var/run/docker.sock']
    original = json.loads(command([*source, 'image', 'inspect', image_id], capture_output=False,
                                  stdout=subprocess.PIPE, text=True))[0]
    if original['Id'] != image_id or original['Architecture'] != 'arm64' or original['Size'] > 1024**3:
        raise ValueError('probe requires a small, existing Linux ARM64 image')
    root = Path(tempfile.mkdtemp(prefix='teamaibox-image-roundtrip-', dir='/var/tmp'))
    if shutil.disk_usage(root).free < original['Size'] * 5 + 512 * 1024**2:
        raise ValueError('insufficient probe workspace')
    root.chmod(0o700)
    (root / 'daemon.json').write_text('{}\n')
    archive = root / 'image.tar'
    with archive.open('xb') as output:
        command([*source, 'image', 'save', image_id], stdout=output, timeout=300)
    socket = root / 'engine.sock'
    dest = ['docker', '--host', 'unix://' + str(socket)]
    namespace = root.name
    flags = ['dockerd', '--config-file=' + str(root / 'daemon.json'), '--host=unix://' + str(socket),
             '--data-root=' + str(root / 'data'), '--exec-root=' + str(root / 'exec'),
             '--pidfile=' + str(root / 'daemon.pid'), '--bridge=none', '--iptables=false',
             '--ip6tables=false', '--ip-forward=false', '--ip-masq=false', '--userland-proxy=false',
             '--storage-driver=vfs', '--containerd-namespace=' + namespace,
             '--containerd-plugins-namespace=' + namespace + '-plugins']
    report = dict(workspace=str(root), sourceImageId=image_id, sourceImageBytes=original['Size'],
                  sourceDaemonMutated=False, productTestsRun=False, status='incomplete')
    with (root / 'daemon.log').open('xb') as log:
        child = subprocess.Popen(flags, stdout=log, stderr=subprocess.STDOUT,
                                 env={k: v for k, v in os.environ.items() if not k.lower().endswith('_proxy')})
        try:
            deadline = time.monotonic() + 45
            while True:
                if child.poll() is not None:
                    raise RuntimeError('isolated daemon exited; inspect its local daemon.log')
                if socket.exists():
                    ready = subprocess.run([*dest, 'info', '--format', '{{.DockerRootDir}}'],
                                           capture_output=True, text=True, timeout=3)
                    if ready.returncode == 0:
                        if ready.stdout.strip() != str(root / 'data'):
                            raise RuntimeError('isolated Docker data root mismatch')
                        break
                if time.monotonic() >= deadline:
                    raise RuntimeError('isolated daemon startup timed out')
                time.sleep(0.5)
            before = command([*dest, 'image', 'ls', '-q'], stdout=subprocess.PIPE, text=True)
            if before.strip():
                raise RuntimeError('probe daemon was not empty')
            command([*dest, 'image', 'load', '--input', str(archive)], stdout=subprocess.PIPE, timeout=300)
            loaded = json.loads(command([*dest, 'image', 'inspect', image_id], stdout=subprocess.PIPE, text=True))[0]
            if loaded['Id'] != image_id or loaded['Architecture'] != 'arm64':
                raise RuntimeError('imported image identity changed')
            # No published ports, mounts, privilege or external networking.
            command([*dest, 'run', '--rm', '--pull=never', '--network=none', '--memory=64m',
                     '--pids-limit=32', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                     '--entrypoint=/bin/sh', image_id, '-c', 'exit 0'], stdout=subprocess.PIPE, timeout=30)
            report.update(imageRoundtripPassed=True, loadedImageId=loaded['Id'], loadedRepoDigests=loaded.get('RepoDigests', []),
                          runByContentId=True, pullUsed=False, containerNetwork='none', archiveBytes=archive.stat().st_size)
            if migration:
                report['migration'] = migration_probe(dest, image_id, *migration)
            report['status'] = 'passed'
        finally:
            child.terminate()
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)
            report['isolatedDaemonStopped'] = child.poll() is not None
            (root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-image', required=True)
    parser.add_argument('--migration-up', type=Path)
    parser.add_argument('--migration-down', type=Path)
    args = parser.parse_args()
    if bool(args.migration_up) != bool(args.migration_down):
        parser.error('provide both migration paths')
    migration = (args.migration_up.read_text(), args.migration_down.read_text()) if args.migration_up else None
    print(json.dumps(probe(args.source_image, migration), indent=2))
