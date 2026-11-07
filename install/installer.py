#!/usr/bin/env python3
"""Offline installation coordinator. No downloads and no Docker/driver restart."""
from __future__ import annotations

import argparse
from copy import deepcopy
import fcntl
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
import uuid

from offline_common import InstallError, atomic, digest, need, nvidia_gpu_argument, read_json, run, validate_release, verify_package, within, write_json
from offline_host_packages import install as install_tool_packages, ROOT_PACKAGES


def safe_root(value):
    root = Path(value)
    need(root.is_absolute() and '..' not in root.parts and len(root.parts) >= 3,
         'installation root must be a dedicated absolute directory')
    for path in (root, *root.parents):
        need(not path.is_symlink(), 'installation path contains symlink: ' + str(path))
    need(str(root) not in ('/etc/teamaibox', '/usr/local', '/var/lib', '/srv/teamaibox/data'),
         'choose a dedicated installation directory, not an existing data/configuration root')
    return root


def filesystem(path):
    path = Path(path)
    while not path.exists():
        path = path.parent
    return path.stat().st_dev, shutil.disk_usage(path).free


def required_space(manifest, root=None, installed_images=()):
    images = {row['imageId']: row['unpackedBytes'] for row in manifest['images']}
    # Export layers may overlap; the sum is a safe upper bound for import.
    imported = sum(size for image, size in images.items() if image not in installed_images)
    def missing(name, row):
        if root is None:
            return row['size']
        path = within(root, name)
        if not path.exists():
            return row['size']
        need(path.is_file() and path.stat().st_size == row['size'] and digest(path) == row['sha256'],
             'existing installed file differs; preserved: ' + name)
        return 0
    assets = sum(missing('data/' + asset['destination'] + '/' + row['path'], row)
                 for asset in manifest['assets'] for row in asset['files'])
    runtime = sum(missing(name, row) for name, row in manifest['files'].items() if name.startswith('runtime/'))
    return imported, assets + runtime + manifest['host']['freeReserveBytes']


def check_space(manifest, root, docker_root, *, resuming=False, installed_images=()):
    imported, data = required_space(manifest, Path(root) if resuming else None, installed_images)
    demands = {}
    for path, size in ((docker_root, imported), (root, data)):
        device, free = filesystem(path)
        old = demands.setdefault(device, {'free': free, 'needed': 0})
        old['needed'] += size
    for row in demands.values():
        need(row['free'] >= row['needed'], f"insufficient installation space: need {row['needed']} bytes, available {row['free']}")
    return demands


def read_state(root, manifest):
    state_path = root / 'install-state.json'
    if state_path.exists():
        need(not state_path.is_symlink() and state_path.stat().st_uid == os.geteuid()
             and not state_path.stat().st_mode & 0o077, 'unsafe installation state')
        state = read_json(state_path)
        need(state.get('schemaVersion') == 1 and state.get('root') == str(root), 'installation state conflict')
        need(state.get('releaseId') == manifest['releaseId'] and state.get('sourceCommit') == manifest['sourceCommit'],
             'different release already installed; use the upgrade entry point')
        uuid.UUID(state['installationId'])
        uuid.UUID(state['nodeId'])
        return state
    need(not root.exists() or not any(root.iterdir()), 'unregistered files exist at installation root; preserved unchanged')
    return None


def existing_installation_guard(root, state, record_path=Path('/etc/teamaibox/installation.json')):
    if record_path.exists():
        record = read_json(record_path)
        need(state is not None and record.get('installationId') == state['installationId']
             and record.get('nodeId') == state['nodeId'], 'an existing Team AI Box installation is present; fresh install refused')


def host_facts(runner=run):
    """Read capabilities, never install packages or repair the host in preflight."""
    os_info = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    commands = ('docker', 'python3', 'openssl', 'systemctl', 'dpkg-query', 'apt-get', 'nvidia-smi')
    missing = [cmd for cmd in commands if not shutil.which(cmd)]
    need(not missing, 'factory system command missing: ' + ', '.join(missing))
    docker = json.loads(runner(['docker', 'info', '--format', '{{json .}}']))
    # Factory workers and Node Agent use this Unix socket. A CLI context
    # that targets another engine must not qualify GPU access for this one.
    local_id = runner(['docker', '--host', 'unix:///var/run/docker.sock',
                       'info', '--format', '{{.ID}}']).strip()
    need(local_id and docker.get('ID') == local_id,
         'Docker CLI must target the local /var/run/docker.sock engine used by Team AI Box')
    device = Path('/dev/kvm')
    return dict(platform=sys.platform, architecture=platform.machine(), uid=os.geteuid(),
                os=os_info['ID'].strip('"') + ':' + os_info['VERSION_ID'].strip('"'),
                docker=docker, compose=runner(['docker', 'compose', 'version', '--short']).strip(),
                gpu=runner(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader']),
                kvm=device.exists() and stat.S_ISCHR(device.stat().st_mode) and os.access(device, os.R_OK | os.W_OK),
                timestamp=time.time())


def validate_host_facts(manifest, facts):
    need(facts['platform'] == 'linux' and facts['architecture'] in ('aarch64', 'arm64'), 'DGX Spark Linux ARM64 is required')
    need(facts['uid'] == 0, 'run with sudo; --check also needs local Docker/KVM access')
    need(facts['os'] in manifest['host']['os'], 'unsupported factory OS: ' + facts['os'])
    docker = facts['docker']
    need(docker['OSType'] == 'linux' and docker['Architecture'] in ('aarch64', 'arm64'), 'Docker must target this ARM64 Linux host')
    need(facts['compose'], 'Docker Compose required')
    need('GB10' in facts['gpu'], 'supported NVIDIA GB10 GPU not detected')
    need(facts['kvm'], 'KVM is unavailable')
    need(facts['timestamp'] > 1735689600, 'system clock invalid; correct the factory system clock')


def local_probe_image(reference, runner=run):
    # Don't treat an unreachable Docker daemon as a missing image.
    if reference.startswith('sha256:'):
        ids = runner(['docker', 'image', 'ls', '-a', '-q', '--no-trunc']).split()
        if reference not in ids:
            return None
    result = subprocess.run(['docker', 'image', 'inspect', reference], capture_output=True, text=True, timeout=15)
    if result.returncode:
        need('No such image' in result.stderr, 'cannot inspect GPU probe image')
        return None
    image = json.loads(result.stdout)[0]
    need(image['Os'] == 'linux' and image['Architecture'] == 'arm64'
         and re.fullmatch('sha256:[0-9a-f]{64}', image['Id']), 'unexpected GPU probe image identity')
    return image['Id']


def verify_container_gpu(image_id, runner=run):
    need(re.fullmatch('sha256:[0-9a-f]{64}', image_id), 'GPU probe requires a local image ID')
    # Same device driver/count as office workers. No pulls, mounts, network,
    # model allocation or daemon configuration; Docker removes the probe.
    try:
        output = runner(['docker', 'run', '--rm', '--pull=never', '--network=none',
                         '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                         '--label', 'com.teamaibox.gpu-probe=install',
                         '--gpus', nvidia_gpu_argument(),
                         '--env', 'NVIDIA_DRIVER_CAPABILITIES=utility',
                         '--entrypoint', '/usr/bin/nvidia-smi', image_id, '-L'], timeout=30)
    except (InstallError, subprocess.TimeoutExpired):
        raise InstallError('Docker NVIDIA GPU probe failed using --gpus driver=nvidia,count=all; '
                           'the installer did not change Docker or the NVIDIA driver') from None
    need(re.search(r'^GPU \d+: NVIDIA GB10\b', output, re.MULTILINE),
         'Docker GPU probe did not detect the NVIDIA GB10 inside the container')
    return 'nvidia-device-requests'


def packaged_gpu_probe(manifest, *, required=False):
    image = next((r['imageId'] for r in manifest['images'] if r['role'] == 'translation-worker'), None)
    image_id = local_probe_image(image) if image else None
    if image_id:
        return verify_container_gpu(image_id)
    need(not required, 'verified release GPU worker image is not available for the Docker GPU probe')
    return 'pending-image'


def preflight(manifest, root, state, runner=run):
    need(sys.platform == 'linux' and platform.machine() in ('aarch64', 'arm64'), 'DGX Spark Linux ARM64 is required')
    need(os.geteuid() == 0, 'run with sudo; --check also needs local Docker/KVM access')
    facts = host_facts(runner)
    validate_host_facts(manifest, facts)
    docker = facts['docker']
    existing_installation_guard(root, state)
    if state is None:
        for port in (80, 443):
            with socket.socket() as probe:
                try:
                    probe.bind(('0.0.0.0', port))
                except OSError:
                    raise InstallError(f'port {port} is occupied; existing service was not stopped') from None
        owned = runner(['docker', 'ps', '-aq', '--filter', 'label=com.teamaibox.managed=true']).strip()
        need(not owned, 'unregistered Team AI Box containers found; refusing a second installation')
    space = {}
    if not state or state.get('status') != 'complete':
        # A partial import must not be charged again against already consumed
        # disk space. Only exact Linux ARM64 identities earn this credit.
        local_ids = runner(['docker', 'image', 'ls', '-a', '-q', '--no-trunc']).split()
        local = json.loads(runner(['docker', 'image', 'inspect', *sorted(set(local_ids))])) if local_ids else []
        installed = {v['Id'] for v in local if v.get('Architecture') == 'arm64' and v.get('Os') == 'linux'}
        space = check_space(manifest, root, docker['DockerRootDir'], resuming=bool(state), installed_images=installed)
    return dict(os=facts['os'], dockerRoot=docker['DockerRootDir'], space=space,
                hostPackages=len(manifest.get('hostPackages', [])))


def input_path(inputs, name):
    return inputs[name] if isinstance(inputs, dict) else within(inputs, name)


def install_host_packages(manifest, package, runner=run):
    packages = [dict(source=str(input_path(package, row['path'])), sha256=row['sha256']) for row in manifest.get('hostPackages', [])]
    install_tool_packages(packages, manifest['host'].get('requiredPackages', ROOT_PACKAGES), runner)
    for cmd in manifest['host']['commands']:
        need(shutil.which(cmd), 'required offline host tool unavailable: ' + cmd)


def stream_copy(source, target, expected, mode=0o644):
    if target.exists():
        need(target.is_file() and not target.is_symlink(), 'asset destination conflict')
        if target.stat().st_size == expected['size'] and digest(target) == expected['sha256']:
            return
        raise InstallError('existing installed asset differs; refusing overwrite: ' + str(target))
    target.parent.mkdir(parents=True, exist_ok=True)
    pending = target.with_name('.' + target.name + '.installing')
    need(not pending.is_symlink(), 'unsafe temporary asset')
    with source.open('rb') as src, pending.open('wb') as dst:
        shutil.copyfileobj(src, dst, 4 * 1024 * 1024)
        dst.flush()
        os.fsync(dst.fileno())
    need(pending.stat().st_size == expected['size'] and digest(pending) == expected['sha256'], 'copy integrity failure')
    pending.chmod(mode)
    os.replace(pending, target)


def install_runtime(manifest, package, root):
    for name, info in manifest['files'].items():
        if name.startswith('runtime/'):
            stream_copy(input_path(package, name), within(root, name), info, info['mode'])


def install_assets(manifest, package, root):
    data = root / 'data'
    need(os.path.ismount(data), 'protected data volume is not mounted; refusing plaintext asset writes')
    for asset in manifest['assets']:
        for item in asset['files']:
            target = within(data, asset['destination'] + '/' + item['path'])
            source = input_path(package, asset['packagePath'] + '/' + item['path'])
            stream_copy(source, target, item, item.get('mode', 0o644))


def import_images(manifest, package, runner=run):
    seen = set()
    for row in manifest['images']:
        if row['imageId'] in seen:
            continue
        result = subprocess.run(['docker', 'image', 'inspect', row['imageId']], capture_output=True, text=True)
        if result.returncode:
            runner(['docker', 'image', 'load', '--input', within(package, row['archive'])], timeout=7200)
        actual = json.loads(runner(['docker', 'image', 'inspect', row['imageId']]))[0]
        need(actual['Id'] == row['imageId'] and actual['Architecture'] == 'arm64', 'imported image identity mismatch')
        seen.add(row['imageId'])


def phase_arguments(step, action, root):
    command = step[action]
    return [sys.executable, str(within(root / 'runtime', command[1])), *command[2:],
            '--installation-root', str(root)]


def execute_phase(step, root, runner=run):
    print('安装阶段 / phase: ' + step['phase'], flush=True)
    # Checks must exit nonzero for incomplete work. Apply only in that case.
    check = subprocess.run(phase_arguments(step, 'check', root), capture_output=True, text=True,
                           timeout=step['timeoutSeconds'])
    if check.returncode:
        runner(phase_arguments(step, 'apply', root), timeout=step['timeoutSeconds'])
    runner(phase_arguments(step, 'check', root), timeout=step['timeoutSeconds'])


def wait_ready(manifest, state, runner=run, *, clock=time.monotonic, sleep=time.sleep, report_path=None):
    started = clock()
    pending = {row['role']: started + row['timeoutSeconds'] for row in manifest['readiness']}
    statuses, failures = {}, []
    selectors = {row['role']: row.get('containerRole', row['role']) for row in manifest['readiness']}
    while pending:
        for role, deadline in list(pending.items()):
            ids = runner(['docker', 'ps', '-aq', '--filter', 'label=com.teamaibox.installation-id=' + state['installationId'],
                          '--filter', 'label=com.teamaibox.service-role=' + selectors[role]]).split()
            status = 'waiting'
            if len(ids) == 1:
                c = json.loads(runner(['docker', 'inspect', ids[0]]))[0]
                running = c['State'].get('Running')
                health = c['State'].get('Health', {}).get('Status')
                status = 'ready' if running and health == 'healthy' else 'loading' if running else 'waiting'
            elif len(ids) > 1:
                status = 'identity-conflict'
            if status == 'ready':
                pending.pop(role)
            elif status == 'identity-conflict' or clock() >= deadline:
                status = 'failed'
                failures.append(role)
                pending.pop(role)
            if statuses.get(role) != status:
                statuses[role] = status
                print(role + ': ' + status, flush=True)
        if report_path:
            write_json(report_path, dict(installationId=state['installationId'], components=statuses,
                                        status='waiting' if pending else 'failed' if failures else 'ready'))
        if pending:
            sleep(5)
    need(not failures, 'components not ready: ' + ', '.join(failures) + '; rerun this installer to resume')
    return statuses


INSTALL_LOCK = Path('/run/lock/teamaibox-offline-install.lock')


def install(package, root, check=False, *, lock_path=INSTALL_LOCK):
    manifest = verify_package(package)
    return install_verified(manifest, package, root, check, lock_path=lock_path,
                            input_digest=digest(package / 'release.json'))


def verify_source_images(manifest, runner=run):
    """Direct installs cannot pull or import a missing image."""
    from image_role import verify_application_role
    for row in manifest['images']:
        image = json.loads(runner(['docker','image','inspect',row['imageId']]))[0]
        need(image['Id']==row['imageId'] and image['Os']=='linux' and image['Architecture']=='arm64'
             and image['Size']==row['unpackedBytes'], 'local source image missing or changed: '+row['role'])
        verify_application_role(row['role'], image)


def source_inputs(release_path, repository, runner=run):
    """Bind a prepared release to local files; never materialize an export."""
    import hashlib
    from artifact_validation import validate_android_bindings
    manifest = deepcopy(validate_release(read_json(release_path)))
    need(runner(['git','-C',repository,'rev-parse','HEAD']).strip()==manifest['sourceCommit'],
         'prepared release does not match the source checkout')
    validate_android_bindings(manifest['assets'],manifest['images'])
    paths, records = {}, {}
    def bind(name,path,info):
        need(path.is_file() and path.resolve()==path and name not in paths, 'invalid source input: '+name)
        paths[name], records[name] = path, info
    for script in manifest['runtimeFiles']:
        path = within(repository,script)
        bind('runtime/'+script,path,dict(size=path.stat().st_size,sha256=digest(path),mode=path.stat().st_mode & 0o777))
    for asset in manifest['assets']:
        base = Path(asset.pop('source'))
        asset['packagePath'] = 'assets/'+asset['role']
        for item in asset['files']:
            path = within(base,item['path'])
            need(path.stat().st_size==item['size'] and digest(path)==item['sha256'],
                 'source asset changed: '+asset['role']+'/'+item['path'])
            bind(asset['packagePath']+'/'+item['path'],path,item)
    for i,row in enumerate(manifest.get('hostPackages',[])):
        path = Path(row.pop('source'))
        need(path.suffix=='.deb' and digest(path)==row['sha256'], 'host package changed')
        row['path'] = 'host-packages/'+str(i)+'.deb'
        bind(row['path'],path,dict(size=path.stat().st_size,sha256=row['sha256'],mode=0o644))
    for row in manifest['images']:
        row.pop('reference')
    manifest['files'] = records
    # Only sanitized IDs/checksums go to the installation and resume journal.
    manifest['imageTransport'] = 'local'
    receipt = hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return manifest,paths,receipt


def install_source(release_path, repository, root, *, lock_path=INSTALL_LOCK):
    manifest, paths, receipt = source_inputs(release_path, repository)
    verify_source_images(manifest)
    return install_verified(manifest, paths, safe_root(root), False, lock_path=lock_path,
                            input_digest=receipt, local_images=True)


def install_verified(manifest, package, root, check, *, lock_path, input_digest, local_images=False):
    state = read_state(root, manifest)
    facts = preflight(manifest, root, state)
    if check:
        return dict(status='preflight-passed', releaseId=manifest['releaseId'], installed=False,
                    dockerGpuAccess=packaged_gpu_probe(manifest), **facts)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise InstallError('another installation is running') from None
        # Recheck after lock: concurrent callers might have finished preflight together.
        state = read_state(root, manifest)
        existing_installation_guard(root, state)
        if state is None:
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            state = dict(schemaVersion=1, root=str(root), releaseId=manifest['releaseId'], sourceCommit=manifest['sourceCommit'],
                         installationId=str(uuid.uuid4()), nodeId=str(uuid.uuid4()), status='installing', completed=[])
            write_json(root / 'install-state.json', state)
        need(state.get('packageDigest', input_digest) == input_digest,
             'install inputs changed during interrupted installation')
        if state['status'] == 'complete':
            for step in manifest['steps']:
                run(phase_arguments(step, 'check', root), timeout=step['timeoutSeconds'])
            return dict(status='unchanged', releaseId=manifest['releaseId'], existingDataChanged=False)
        state['packageDigest'] = input_digest
        write_json(root / 'install-state.json', state)
        try:
            install_host_packages(manifest, package)
            install_runtime(manifest, package, root)
            # Persist only the distributable manifest, not build-machine source paths.
            write_json(root / 'release.json', manifest)
            # Import before sizing the new sparse data filesystem so its initial
            # physical-space calculation includes Docker's unpacked image use.
            if local_images:
                verify_source_images(manifest)
            else:
                import_images(manifest, package)
            state['dockerGpuAccess'] = packaged_gpu_probe(manifest, required=True)
            write_json(root / 'install-state.json', state)
            for step in manifest['steps']:
                state['currentPhase'] = step['phase']
                write_json(root / 'install-state.json', state)
                if step['phase'] == 'configuration':
                    install_assets(manifest, package, root)
                execute_phase(step, root)
                if step['phase'] not in state['completed']:
                    state['completed'].append(step['phase'])
                write_json(root / 'install-state.json', state)
            wait_ready(manifest, state, report_path=root / 'readiness.json')
            state['status'] = 'complete'
            state.pop('failure', None)
            state.pop('currentPhase', None)
            write_json(root / 'install-state.json', state)
            return dict(status='installed', releaseId=manifest['releaseId'], installationId=state['installationId'],
                        initialAdministrator='admin',
                        browserCaFile=str(root / 'https/ca.crt'),
                        installationRecord=str(root / 'installation.json'),
                        next='Sign in at the appliance HTTPS address with admin / admin; change the initial password after login. See README.zh-CN.md')
        except Exception as error:
            state['status'] = 'incomplete'
            state['failure'] = type(error).__name__
            write_json(root / 'install-state.json', state)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--installation-root', type=Path, default=Path('/srv/teamaibox/installation'))
    parser.add_argument('--check', action='store_true', help='Verify package and target without installing')
    parser.add_argument('--verify-package', action='store_true', help='Verify package only, including on a packaging workstation')
    args = parser.parse_args()
    if args.verify_package:
        value = verify_package(args.package)
        result = dict(status='verified', releaseId=value['releaseId'], installed=False)
    else:
        result = install(args.package.resolve(), safe_root(args.installation_root), args.check)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (InstallError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print('安装未完成 / Installation incomplete: ' + str(error), file=sys.stderr)
        print('原数据保留。解决上述问题后，重新运行同一个 install.sh 继续。', file=sys.stderr)
        raise SystemExit(1)
