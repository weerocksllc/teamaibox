#!/usr/bin/env python3
"""Boot-only sequential start of an exact pre-existing office set.

No create/remove/update, image pulls, new GPU jobs, or desired-state learning.
A replacement container/image/configuration requires a separately reviewed
successor manifest. Normal runtime lifecycle remains owned by the Node Agent.
"""
import argparse
from copy import deepcopy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

MANIFEST = Path('/usr/local/lib/teamaibox/boot-restore-v1/office-workers.json')


def need(value, code):
    if not value:
        raise RuntimeError(code)


def command(args):
    p = subprocess.run(args, text=True, capture_output=True, timeout=90)
    need(p.returncode == 0, 'bounded_container_operation_failed')
    return p.stdout


def configuration_digest(c, *, legacy_oom=False):
    # Hash environment/configuration without exposing their contents.
    data = {k: deepcopy(c[k]) for k in ('Config', 'HostConfig')}
    # Engine 28 persists unset DNS lists as null, then restores them as [].
    # Both mean "no per-container DNS override". Nonempty values remain bound.
    for name in ('Dns', 'DnsOptions', 'DnsSearch'):
        if data['HostConfig'].get(name) == []:
            data['HostConfig'][name] = None
    # Docker changes OomKillDisable from false before the first start to null
    # after starting on cgroup v2. Both retain the normal OOM killer. Bind true
    # distinctly; never mistake this engine normalization for user mutation.
    if not legacy_oom and data['HostConfig'].get('OomKillDisable') is None:
        data['HostConfig']['OomKillDisable'] = False
    # Docker emits this list from an unordered map; list order is not config.
    data['Mounts'] = sorted(c['Mounts'], key=lambda item: item['Destination'])
    return hashlib.sha256(json.dumps(data,
                                    sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def validate_identity(actual, expected):
    digests = {configuration_digest(actual)}
    if actual['HostConfig'].get('OomKillDisable') is False:
        legacy = deepcopy(actual)
        legacy['HostConfig']['OomKillDisable'] = None
        digests.add(configuration_digest(legacy, legacy_oom=True))
    else:
        digests.add(configuration_digest(actual, legacy_oom=True))
    need(actual['Id'] == expected['id'] and actual['Image'] == expected['image']
         and actual['Name'] == '/' + expected['name']
         and expected['configurationSha256'] in digests,
         'office_container_identity_or_configuration_drift')
    need(actual['HostConfig']['RestartPolicy']['Name'] == 'no', 'unexpected_restart_policy')
    need(actual['HostConfig'].get('AutoRemove') is False, 'auto_remove_container_rejected')


def inspect(expected):
    actual = json.loads(command(['docker', 'inspect', expected['name']]))[0]
    validate_identity(actual, expected)
    return actual


def validate_manifest(value):
    version = value['schemaVersion']
    need(version in (1, 2), 'invalid_office_manifest')
    names = [c['name'] for c in value['containers']]
    # Version 1 remains readable for rollback; current direct OCR needs six workers only.
    count = 7 if version == 1 else 6
    need(len(names) == len(set(names)) == count
         and sum(n.startswith('teamaibox-worker-') for n in names) == 6
         and (version == 2 or 'teamaibox-protected-office-ocr-provider-v1' in names), 'invalid_office_set')
    return value['containers']


def manifest(path=MANIFEST):
    need(path.resolve() == path, 'manifest_symlink_rejected')
    s = path.stat()
    need(s.st_uid == 0 and not s.st_mode & 0o022, 'unsafe_manifest_permissions')
    return validate_manifest(json.loads(path.read_text()))


def run(check_only=False):
    expected = manifest()
    # Validate the whole set before starting anything.
    for c in expected:
        inspect(c)
    reports = []
    for c in expected:
        before = inspect(c)
        if not before['State']['Running']:
            need(not check_only, 'office_worker_not_running')
            command(['docker', 'start', c['id']])
        deadline = time.monotonic() + (1 if check_only else 900)
        while True:
            actual = inspect(c)
            need(actual['State']['Running'] and not actual['State']['OOMKilled'], 'office_worker_failed_during_boot')
            if actual['State'].get('Health', {}).get('Status') == 'healthy':
                break
            need(time.monotonic() < deadline, 'office_worker_health_timeout')
            time.sleep(5)
        fact = {'name': c['name'], 'containerId': actual['Id'], 'imageId': actual['Image'],
                'startedAt': actual['State']['StartedAt'], 'healthy': True,
                'startedHere': not before['State']['Running']}
        reports.append(fact)
        print(json.dumps(fact), flush=True)
    print(json.dumps({'status': 'passed', 'officeSetHealthy': True, 'count': len(reports)}), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--check', action='store_true')
    args = p.parse_args()
    try:
        need(os.geteuid() == 0, 'root_required')
        with open('/run/lock/teamaibox-office-boot.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            run(args.check)
    except Exception as error:
        print(json.dumps({'status': 'failed', 'failure': str(error) if isinstance(error, RuntimeError)
                          else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
