#!/usr/bin/env python3
"""Boot-only restore of the exact existing six office models.

Observes actual host pressure without pre-booking model or guest capacity.
Never replaces containers, pulls images, drains guests or changes user data.
"""
import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import stat
import restore_existing_office_workers as legacy

GIB = 2 ** 30
QUANTUM = 256 * 2 ** 20


def need(value, code):
    if not value:
        raise RuntimeError(code)


def database_container():
    value = os.environ.get('TEAMAIBOX_POSTGRES_CONTAINER', '')
    need(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', value), 'local_database_container_required')
    return value


def validate_appliance_binding(value):
    node = os.environ.get('PLATFORM_APPLIANCE_NODE_ID', '')
    need(re.fullmatch(r'[a-f0-9-]{36}', node) and node == value['nodeId'], 'boot_appliance_identity_mismatch')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_configuration(value, base, base_bytes):
    need(set(value) - {'coreMemoryBudget'} == {'schemaVersion', 'nodeId', 'baseManifestSha256',
                       'models', 'independentMediaContainerId'}, 'invalid_boot_configuration')
    need(value['schemaVersion'] in (1, 2) and re.fullmatch('[a-f0-9-]{36}', value['nodeId'] or '')
         and value['baseManifestSha256'] == digest(base_bytes), 'boot_parent_changed')
    entries = legacy.validate_manifest(base)
    need(base['schemaVersion'] == 2 and len(value['models']) == len(entries) == 6, 'invalid_boot_model_set')
    need([p['containerId'] for p in value['models']] == [p['id'] for p in entries]
         and len({p['workerId'] for p in value['models']}) == 6, 'boot_model_order_or_identity_changed')
    for model, entry in zip(value['models'], entries):
        need(set(model) == {'workerId', 'containerId', 'declaredResidentBytes'}
             and entry['name'] == 'teamaibox-worker-' + model['workerId']
             and type(model['declaredResidentBytes']) is int and model['declaredResidentBytes'] > 0,
             'invalid_boot_model_envelope')
    need(re.fullmatch('[a-f0-9]{64}', value['independentMediaContainerId'] or ''), 'invalid_media_identity')
    return entries


def observe(value, snapshot, missing):
    for name in ('totalBytes', 'availableBytes', 'swapUsedBytes'):
        need(type(snapshot.get(name)) is int and snapshot[name] >= 0, 'invalid_boot_memory_evidence')
    need(0 < snapshot['totalBytes'] >= snapshot['availableBytes'], 'invalid_boot_memory_evidence')
    need(math.isfinite(snapshot['fullAverage10']) and 0 <= snapshot['fullAverage10'] < 0.1
         and not snapshot['oomKilled'], 'boot_memory_pressure')
    return {k:snapshot[k] for k in ('totalBytes','availableBytes','fullAverage10')}


def restore(value, entries, adapter, check_only=False):
    before = {e['id']: adapter.inspect(e) for e in entries}
    need(not check_only or all(c['running'] and c['healthy'] for c in before.values()), 'office_worker_not_running')
    started, reports, samples = [], [], []
    try:
        adapter.wait_ready(check_only)
        missing = {cid for cid, c in before.items() if not c['healthy']}
        samples.append(observe(value, adapter.snapshot(value), missing))
        for entry in entries:
            if not before[entry['id']]['running']:
                samples.append(observe(value, adapter.snapshot(value), missing))
                # Record ownership before start: an interrupted response may hide a successful start.
                started.append(entry)
                adapter.start(entry)
                missing.discard(entry['id'])
            if not check_only and hasattr(adapter, 'retain_gpu_access'):
                adapter.retain_gpu_access(entry)
            deadline = adapter.monotonic() + (1 if check_only else 900)
            while True:
                current = adapter.inspect(entry)
                need(current['running'] and not current['oomKilled'], 'office_worker_failed_during_boot')
                # Running is not readiness; wait for this exact worker health.
                samples.append(observe(value, adapter.snapshot(value), missing))
                if current['healthy']:
                    missing.discard(entry['id'])
                    break
                need(adapter.monotonic() < deadline, 'office_worker_health_timeout')
                adapter.sleep(3)
            reports.append(dict(name=entry['name'], containerId=entry['id'], imageId=entry['image'],
                                startedAt=current['startedAt'], startedHere=entry in started, healthy=True))
        samples.append(observe(value, adapter.snapshot(value), set()))
        return dict(status='passed', officeSetHealthy=True, count=6, workers=reports,
                    initialObservation=samples[0], finalObservation=samples[-1], sampleCount=len(samples),
                    minAvailableBytes=min(s['availableBytes'] for s in samples),
                    checkOnly=check_only, startedIds=[e['id'] for e in started])
    except Exception as error:
        failures = []
        for entry in reversed(started):
            try:
                adapter.stop(entry)
                need(not adapter.inspect(entry)['running'], 'rollback_worker_still_running')
            except Exception:
                failures.append(entry['id'])
        code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        raise RuntimeError(json.dumps(dict(failure=code, startedIds=[e['id'] for e in started],
                                          rollbackFailures=failures, cleanupComplete=not failures))) from None


def wait_for_database(probe, monotonic, sleep, check_only=False, timeout=120):
    deadline = monotonic() + timeout
    while True:
        try:
            if probe():
                return
        except subprocess.TimeoutExpired:
            pass
        need(not check_only, 'boot_database_not_ready')
        remaining = deadline - monotonic()
        need(remaining > 0, 'boot_database_ready_timeout')
        sleep(min(2, remaining))


def gpu_allow_arguments(existing, devices):
    # Preserve all existing Docker device rules. Never relax DevicePolicy or
    # add wildcard GPU access; these nodes were already injected by NVIDIA.
    rules = list(dict.fromkeys(existing + [path + ' rwm' for path in devices]))
    return ['DeviceAllow='] + ['DeviceAllow=' + rule for rule in rules]


def retain_gpu_access(container):
    """Keep NVIDIA's injected nodes visible to systemd on later daemon reloads.

    A legacy NVIDIA hook does not declare device access to systemd. Explicit
    rules avoid losing GPU access during unit-file maintenance. No restart,
    image, mount, environment, memory budget or guest data is changed here.
    """
    if not any(r.get('Driver') == 'nvidia' for r in container['HostConfig'].get('DeviceRequests') or []):
        return
    cid = container['Id']
    need(re.fullmatch('[a-f0-9]{64}', cid) and container['State']['Running'], 'invalid_gpu_worker')
    candidates = ['/dev/nvidia0', '/dev/nvidiactl', '/dev/nvidia-uvm', '/dev/nvidia-uvm-tools']
    script = 'import json,os,stat;print(json.dumps({p:os.stat(p).st_rdev for p in ' + repr(candidates) + ' if os.path.exists(p) and stat.S_ISCHR(os.stat(p).st_mode)}))'
    observed = json.loads(subprocess.check_output(['docker', 'exec', cid, 'python3', '-c', script], text=True, timeout=10))
    need('/dev/nvidia0' in observed and '/dev/nvidiactl' in observed, 'worker_gpu_devices_missing')
    for path, device in observed.items():
        node = os.stat(path)
        need(stat.S_ISCHR(node.st_mode) and node.st_rdev == device, 'worker_gpu_device_mismatch')
    unit = 'docker-' + cid + '.scope'
    current = subprocess.check_output(['systemctl', 'show', unit, '-p', 'DeviceAllow'], text=True, timeout=10)
    existing = [line.removeprefix('DeviceAllow=') for line in current.splitlines() if line.startswith('DeviceAllow=') and line != 'DeviceAllow=']
    wanted = [path + ' rwm' for path in observed]
    if not all(rule in existing for rule in wanted):
        subprocess.run(['systemctl', 'set-property', '--runtime', unit, *gpu_allow_arguments(existing, list(observed))], check=True, capture_output=True, timeout=15)


class HostAdapter:
    monotonic = staticmethod(time.monotonic)
    sleep = staticmethod(time.sleep)

    def database_ready(self):
        # Docker being active does not mean PostgreSQL has finished recovery.
        # Probe existing storage only; never create/migrate/restart a database.
        p = subprocess.run(['docker', 'exec', database_container(), 'psql', '-X', '-U', 'teamaibox',
                            '-d', 'teamaibox', '-Atc', 'SELECT 1'],
                           text=True, capture_output=True, timeout=5)
        return p.returncode == 0 and p.stdout.strip() == '1'

    def wait_ready(self, check_only=False):
        wait_for_database(self.database_ready, self.monotonic, self.sleep, check_only)

    def inspect(self, entry):
        c = legacy.inspect(entry)
        h = c['HostConfig']
        need(h['Memory'] == entry['memoryLimitBytes'] and h['MemorySwap'] == h['Memory'], 'boot_worker_hard_limit_or_swap_changed')
        return dict(running=c['State']['Running'], healthy=c['State'].get('Health', {}).get('Status') == 'healthy',
                    oomKilled=c['State']['OOMKilled'], startedAt=c['State']['StartedAt'])

    def start(self, entry):
        legacy.command(['docker', 'start', entry['id']])

    def retain_gpu_access(self, entry):
        retain_gpu_access(legacy.inspect(entry))

    def stop(self, entry):
        legacy.command(['docker', 'stop', '--time', '20', entry['id']])

    def snapshot(self, value):
        mem = {k:int(v.split()[0])*1024 for k,v in (s.split(':',1) for s in Path('/proc/meminfo').read_text().splitlines()) if v.strip().split()[0].isdigit()}
        pressure = dict(s.split('=',1) for s in next(s for s in Path('/proc/pressure/memory').read_text().splitlines() if s.startswith('full ')).split()[1:])
        return dict(totalBytes=mem['MemTotal'],availableBytes=mem['MemAvailable'],
                    swapUsedBytes=mem['SwapTotal']-mem['SwapFree'],fullAverage10=float(pressure['avg10']),oomKilled=False)


def load(path, manifest_path=None):
    need(path.is_absolute() and path.resolve() == path, 'boot_configuration_symlink_rejected')
    st = path.stat()
    need(st.st_uid == 0 and not st.st_mode & 0o022 and st.st_size < 32768, 'unsafe_boot_configuration')
    manifest_path = manifest_path or legacy.MANIFEST
    # Keep the old root-owned file checks and identity contract.
    legacy.manifest(manifest_path)
    base_bytes = manifest_path.read_bytes()
    value = json.loads(path.read_bytes())
    validate_appliance_binding(value)
    database_container()
    entries = validate_configuration(value, json.loads(base_bytes), base_bytes)
    return value, entries


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--configuration', required=True, type=Path)
    p.add_argument('--manifest', type=Path)
    p.add_argument('--check', action='store_true')
    a = p.parse_args()
    try:
        need(os.geteuid() == 0, 'root_required')
        with open('/run/lock/teamaibox-office-boot.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            value, entries = load(a.configuration, a.manifest)
            print(json.dumps(restore(value, entries, HostAdapter(), a.check)), flush=True)
        return 0
    except Exception as error:
        print(json.dumps(dict(status='failed', failure=str(error) if isinstance(error, RuntimeError) else type(error).__name__)), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
