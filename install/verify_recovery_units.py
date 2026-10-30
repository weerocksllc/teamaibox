#!/usr/bin/env python3
"""Parse factory systemd units in a temporary tree, without installing/enabling them."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import uuid

from factory_recovery import definitions
from offline_common import atomic, need, write_json
from package import module_closure
from factory_recipe import RUNTIME_ENTRIES


def verify(repository, helper, output):
    repository, helper, output = repository.resolve(), helper.resolve(strict=True), output.absolute()
    need(not output.exists(), 'verification output already exists; preserved')
    output.mkdir(parents=True)
    root, units = output / 'installation', output / 'units'
    root.mkdir(); units.mkdir()
    identity = str(uuid.uuid4())
    references = {}
    for role in ('storageVolumes', 'frontdoor', 'networkIdentity', 'guestStorage', 'guestCamera',
                 'officeManifest', 'officeBoot', 'castingInstallation'):
        path = root / 'config' / (role + '.json')
        write_json(path, {'validationFixture': True})
        references[role] = str(path)
    for name in module_closure(repository, RUNTIME_ENTRIES):
        destination = root / 'runtime' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(repository / name, destination)
    path = root / 'data/assets/guest-host-tools/phone-storage-helper'
    path.parent.mkdir(parents=True)
    shutil.copyfile(helper, path); path.chmod(0o755)
    files = definitions(root, dict(installationId=identity, nodeId=str(uuid.uuid4()), references=references,
        services={'postgres': {'containerId': 'a' * 64}}), dict(assets=[dict(role='guest-host-tools',
        destination='assets/guest-host-tools')], guestSystems=dict(cameraSources=['usb', 'udp'])))
    for name, content in files.items():
        atomic(units / name, content.encode(), 0o644)
    # Unit search path loads only the generated product definitions plus the
    # OS vendor units. Nothing is placed under /etc/systemd; no daemon reload.
    environment = dict(os.environ, SYSTEMD_UNIT_PATH=str(units) + ':/usr/lib/systemd/system:/lib/systemd/system')
    result = subprocess.run(['systemd-analyze', 'verify', '--man=no',
        *[str(units / n) for n in files if n.endswith(('.service', '.timer'))]],
        env=environment, capture_output=True, text=True, timeout=60)
    atomic(output / 'systemd-verify.log', (result.stdout + result.stderr).encode(), 0o644)
    report = dict(status='passed' if result.returncode == 0 else 'failed', unitFiles=len(files),
        installed=False, enabled=False, hostServicesChanged=False, bootValidated=False,
        fixtureRoot=str(root), commandExit=result.returncode)
    write_json(output / 'report.json', report, 0o644)
    need(result.returncode == 0, 'unit parsing failed; see systemd-verify.log')
    return report


if __name__ == '__main__':
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--helper', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.repository, args.helper, args.output), indent=2))
