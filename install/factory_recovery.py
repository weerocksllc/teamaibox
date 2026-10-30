#!/usr/bin/env python3
"""Install the existing host recovery adapters for one fresh installation.

This is a finite unit-file installer, not another recovery daemon. Existing
unowned unit files are never replaced and Docker is never restarted.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from offline_common import atomic, need, read_json, run, write_json, within


def argument(path):
    text = str(path)
    need('\n' not in text and '\r' not in text and '\x00' not in text, 'invalid unit path')
    return '"' + text.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def unit(command, *, description, after='', requires='', kind='oneshot', restart=True, environment=None):
    lines = ['[Unit]', 'Description=' + description, 'StartLimitIntervalSec=0']
    if after:
        lines.append('After=' + after)
    if requires:
        lines.append('Requires=' + requires)
    lines += ['[Service]', 'Type=' + kind]
    if kind == 'oneshot':
        lines += ['RemainAfterExit=yes', 'TimeoutStartSec=0']
    if restart:
        lines += ['Restart=on-failure', 'RestartSec=10']
    for key, value in (environment or {}).items():
        need(re.fullmatch('[A-Z_][A-Z0-9_]*', key), 'invalid unit environment')
        lines.append('Environment=' + argument(key + '=' + str(value)))
    lines += ['ExecStart=' + ' '.join(argument(v) for v in command), '[Install]', 'WantedBy=multi-user.target', '']
    return '\n'.join(lines)


def definitions(root, installation, release):
    refs = installation['references']
    required = ('storageVolumes', 'frontdoor', 'networkIdentity', 'guestStorage', 'officeManifest', 'officeBoot', 'castingInstallation')
    for name in required:
        path = Path(refs[name])
        need(path.is_relative_to(root) and path.is_file() and not path.is_symlink(), 'recovery input missing: ' + name)
    runtime = root / 'runtime'
    def python(name, *args):
        path = within(runtime, 'tools/' + name)
        need(path.is_file(), 'bundled recovery adapter missing: ' + name)
        return ['/usr/bin/python3', path, *args]
    assets = {v['role']: v for v in release['assets']}
    binary = within(root / 'data', assets['guest-host-tools']['destination'] + '/phone-storage-helper')
    need(binary.is_file() and os.access(binary, os.X_OK), 'guest storage executable missing')
    result = {
        'teamaibox-casting-credentials.service': unit(
            ['/usr/bin/python3', runtime / 'install/factory_casting.py', '--installation-root', root],
            description='Prepare this appliance casting runtime credentials',
            after='teamaibox-existing-business-volumes.service', requires='teamaibox-existing-business-volumes.service'),
        'teamaibox-existing-business-volumes.service': unit(
            python('restore_existing_business_volumes.py', '--configuration', refs['storageVolumes']),
            description='Restore this Team AI Box encrypted data volume'),
        'teamaibox-frontdoor.service': unit(
            python('restore_appliance_frontdoor.py', '--configuration', refs['frontdoor']),
            description='Restore installed Team AI Box services', after='docker.service network-online.target', requires='docker.service'),
        'teamaibox-phone-storage.service': unit(
            [binary, '--config', refs['guestStorage'], '--socket', root / 'guest-runtime/storage.sock'],
            description='Team AI Box local guest storage', kind='simple',
            after='teamaibox-existing-business-volumes.service', requires='teamaibox-existing-business-volumes.service'),
        'teamaibox-guest-devices.service': unit(
            ['/usr/sbin/modprobe', 'vhost_vsock'], description='Prepare existing virtual device kernel support',
            after='systemd-modules-load.service', restart=True),
        'teamaibox-existing-office-workers.service': unit(
            python('restore_calibrated_office_workers_v3.py', '--configuration', refs['officeBoot'], '--manifest', refs['officeManifest']),
            description='Restore Team AI Box AI services independently', after='docker.service teamaibox-frontdoor.service', requires='docker.service',
            environment={'TEAMAIBOX_POSTGRES_CONTAINER': installation['services']['postgres']['containerId'],
                         'PLATFORM_APPLIANCE_NODE_ID': installation['nodeId'],
                         'TEAMAIBOX_AI_BOOT_STATUS_FILE': str(root / 'public/ai-startup.json')}),
        'teamaibox-network-identity.service': '\n'.join([
            '[Unit]', 'Description=Maintain this appliance network addresses', 'After=network-online.target docker.service',
            '[Service]', 'Type=oneshot', 'TimeoutStartSec=90', 'ExecStart=' + ' '.join(argument(v) for v in
                python('appliance_network_identity.py', '--configuration', refs['networkIdentity'])), '']),
        'teamaibox-network-identity.timer': '\n'.join([
            '[Unit]', 'Description=Track appliance address changes', '[Timer]', 'OnBootSec=5s',
            'OnUnitInactiveSec=15s', 'AccuracySec=1s', 'Unit=teamaibox-network-identity.service',
            '[Install]', 'WantedBy=timers.target', '']),
        'docker.service.d/teamaibox-existing-business-volumes.conf': '\n'.join([
            '[Unit]', 'Requires=teamaibox-existing-business-volumes.service teamaibox-guest-devices.service teamaibox-casting-credentials.service',
            'After=teamaibox-existing-business-volumes.service teamaibox-guest-devices.service teamaibox-casting-credentials.service',
            '[Service]', 'ExecStartPre=' + ' '.join(argument(v) for v in
                python('restore_existing_business_volumes.py', '--configuration', refs['storageVolumes'], '--check')), '']),
    }
    if {'usb', 'udp'} & set(release['guestSystems']['cameraSources']):
        path = within(runtime, 'deploy/android/cuttlefish/phone_usb_host_control.py')
        need(path.is_file() and Path(refs['guestCamera']).is_file(), 'USB camera helper missing')
        result['teamaibox-phone-camera.service'] = unit(
            ['/usr/bin/python3', path, '--config', refs['guestCamera'], '--socket', root / 'guest-runtime/camera.sock'],
            description='Team AI Box local camera access', kind='simple', after='teamaibox-existing-business-volumes.service',
            requires='teamaibox-existing-business-volumes.service')
    return result


def install_files(root, installation_id, files, *, unit_root=Path('/etc/systemd/system'), check=False, command=run):
    journal = root / 'recovery-units.json'
    ownership = read_json(journal) if journal.exists() else dict(installationId=installation_id, files={})
    need(ownership['installationId'] == installation_id, 'recovery installation identity differs')
    # Validate every existing destination before writing any of them.
    for name, text in files.items():
        path = within(unit_root, name)
        sha = hashlib.sha256(text.encode()).hexdigest()
        previous = ownership['files'].get(name)
        need(previous is None or previous == sha, 'different recovery definition requires explicit upgrade')
        if path.exists():
            need(previous == sha and path.read_text() == text, 'unowned or modified host unit preserved: ' + name)
        elif check:
            raise ValueError('installed recovery unit missing: ' + name)
    if check:
        names = [n for n in files if n.endswith(('.service', '.timer')) and n != 'teamaibox-network-identity.service']
        command(['systemctl', 'is-enabled', *names])
        return
    # Persist ownership BEFORE publication to permit an interrupted file copy.
    ownership['files'] = {name: hashlib.sha256(raw.encode()).hexdigest() for name, raw in files.items()}
    write_json(journal, ownership)
    for name, text in files.items():
        path = within(unit_root, name)
        if not path.exists():
            atomic(path, text.encode(), 0o644)
    units = [str(within(unit_root, n)) for n in files if n.endswith(('.service', '.timer'))]
    command(['systemd-analyze', 'verify', *units])
    command(['systemctl', 'daemon-reload'])
    names = [n for n in files if n.endswith(('.service', '.timer')) and n != 'teamaibox-network-identity.service']
    command(['systemctl', 'enable', *names])


def activate_helpers(root, installation_id, *, check=False, command=run):
    """Activate only units just registered to this installation.

    First install must not require a reboot to get its local guest sockets or
    DHCP/HTTPS updates. Do not restart Docker or launch office models here;
    model loading has its own installation phase and existing recovery unit.
    """
    owned = read_json(root / 'recovery-units.json')
    need(owned['installationId'] == installation_id, 'helper installation identity differs')
    names = ['teamaibox-guest-devices.service', 'teamaibox-phone-storage.service']
    if 'teamaibox-phone-camera.service' in owned['files']:
        names.append('teamaibox-phone-camera.service')
    names.append('teamaibox-network-identity.timer')
    need(all(name in owned['files'] for name in names), 'new installation helper units incomplete')
    if not check:
        command(['systemctl', 'start', *names], timeout=180)
        command(['systemctl', 'start', 'teamaibox-network-identity.service'], timeout=120)
    command(['systemctl', 'is-active', *names])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installation-root', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    need(os.geteuid() == 0, 'root required')
    root = args.installation_root.resolve()
    from appliance_installation import load
    installation = load(root / 'installation.json')
    need(read_json(root / 'install-state.json')['installationId'] == installation['installationId'], 'installation identity differs')
    files = definitions(root, installation, read_json(root / 'release.json'))
    install_files(root, installation['installationId'], files, check=args.check)
    activate_helpers(root, installation['installationId'], check=args.check)
    print(json.dumps(dict(status='checked' if args.check else 'installed', units=len(files), dockerRestarted=False)))


if __name__ == '__main__':
    main()
