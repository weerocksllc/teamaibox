#!/usr/bin/env python3
"""Read-only Linux baseline for the Android lab. No third-party dependencies."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import platform
import subprocess
import time

GIB = 1024 ** 3


def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise RuntimeError(args[0] + ': ' + result.stderr[-1500:])
    return result.stdout


def sample():
    mem = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    vm = dict(line.split() for line in Path('/proc/vmstat').read_text().splitlines())
    psi = {}
    for line in Path('/proc/pressure/memory').read_text().splitlines():
        kind, *values = line.split()
        psi[kind] = {k: float(v) for k, v in (item.split('=') for item in values)}
    return {'monotonic': time.monotonic(), 'availableBytes': int(mem['MemAvailable'].split()[0])*1024,
            'swapUsedBytes': (int(mem['SwapTotal'].split()[0])-int(mem['SwapFree'].split()[0]))*1024,
            'pswpin': int(vm['pswpin']), 'pswpout': int(vm['pswpout']),
            'psiSomeAvg10': psi['some']['avg10'], 'psiFullAvg10': psi['full']['avg10']}


def containers():
    ids = command(['docker', 'ps', '-q', '--no-trunc']).split()
    if not ids:
        return []
    # Never emit full docker inspect: it can contain credentials in Env.
    fmt = '{{json .Id}} {{json .Name}} {{json .Image}} {{json .State.Status}} {{json .RestartCount}} {{with index .State "Health"}}{{json .Status}}{{else}}"none"{{end}}'
    raw = command(['docker', 'inspect', '--format', fmt, *ids])
    import shlex
    return [dict(zip(('id', 'name', 'image', 'status', 'restartCount', 'health'), shlex.split(line)))
            for line in raw.splitlines()]


def collect(seconds=30):
    kernel = platform.release()
    config = Path('/boot/config-' + kernel).read_text()
    keys = ('CONFIG_KVM=', 'CONFIG_ANDROID_BINDER_IPC=', 'CONFIG_ANDROID_BINDERFS=',
            'CONFIG_ANDROID_BINDER_DEVICES=', 'CONFIG_MEMFD_CREATE=', 'CONFIG_ARM64_4K_PAGES=')
    before = containers()
    samples = [sample()]
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        time.sleep(min(1, max(0, deadline-time.monotonic())))
        samples.append(sample())
    kvm = {'deviceExists': Path('/dev/kvm').exists(), 'apiVersion': None, 'emptyVmCreated': False}
    try:
        with open('/dev/kvm', 'rb', buffering=0) as dev:
            kvm['apiVersion'] = fcntl.ioctl(dev, 0xAE00, 0)
            vmfd = fcntl.ioctl(dev, 0xAE01, 0)
            os.close(vmfd)
            kvm['emptyVmCreated'] = True
    except OSError as exc:
        kvm['error'] = str(exc)
    nvidia = Path('/proc/driver/nvidia/version')
    return {'hostname': platform.node(), 'architecture': platform.machine(), 'kernel': kernel,
            'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'pageBytes': os.sysconf('SC_PAGE_SIZE'), 'kvm': kvm,
            'kernelConfig': [line for line in config.splitlines() if line.startswith(keys)],
            'nvidiaDriver': nvidia.read_text().strip() if nvidia.exists() else None,
            'kernelModprobe': Path('/proc/sys/kernel/modprobe').read_text().strip(),
            'cgroupVersion': command(['docker', 'info', '--format', '{{.CgroupVersion}}']).strip(),
            'containersBefore': before, 'containersAfter': containers(), 'samples': samples,
            'sampleDurationSeconds': samples[-1]['monotonic']-samples[0]['monotonic']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--seconds', type=int, default=30)
    args = parser.parse_args()
    if not 30 <= args.seconds <= 60:
        parser.error('baseline must be between 30 and 60 seconds')
    print(json.dumps(collect(args.seconds), sort_keys=True))
