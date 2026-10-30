#!/usr/bin/env python3
"""Persistent Windows lab runtime. Guest disk, UEFI and TPM share one encrypted mount."""
import argparse
import ctypes
import fcntl
import json
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import time


def disable_process_thp():
    """Avoid direct compaction for this lab process and its children only."""
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(41, 1, 0, 0, 0) != 0 or libc.prctl(42, 0, 0, 0, 0) != 1:
        raise OSError(ctypes.get_errno(), 'process THP disable failed')


def qmp_shutdown(path):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(5)
        sock.connect(str(path))
        stream = sock.makefile('rwb', buffering=0)
        stream.readline()
        for execute in ('qmp_capabilities', 'system_powerdown'):
            stream.write(json.dumps({'execute': execute}).encode()+b'\n')
            while True:
                reply = json.loads(stream.readline())
                if 'return' in reply or 'error' in reply:
                    break


def prepare_guest(work, tpm_interface='tis'):
    """Initialize only a new empty guest. Never replace a partial/existing disk."""
    entries = ('system.qcow2', 'VARS.fd', 'tpm', 'identity.json')
    present = [work.joinpath(name).exists() for name in entries]
    if any(present):
        if not all(present):
            raise RuntimeError('partial persistent guest requires inspection; refusing to replace data')
        identity = json.loads((work/'identity.json').read_text())
        if identity != {'schemaVersion': 1, 'diskGiB': 96, 'diskBus': 'nvme', 'firmware': 'ms', 'tpm': tpm_interface}:
            raise RuntimeError('persistent guest format differs')
        return
    subprocess.run(['qemu-img', 'create', '-f', 'qcow2', str(work/'system.qcow2'), '96G'], check=True)
    shutil.copyfile('/usr/share/AAVMF/AAVMF_VARS.ms.fd', work/'VARS.fd')
    (work/'tpm').mkdir(mode=0o700)
    with (work/'identity.json').open('x') as stream:
        json.dump({'schemaVersion': 1, 'diskGiB': 96, 'diskBus': 'nvme', 'firmware': 'ms', 'tpm': tpm_interface}, stream)


def qemu_args(work, run, tpm_interface='tis', tpm_ppi=False):
    if tpm_interface not in ('tis', 'crb'):
        raise ValueError('unsupported TPM interface')
    if tpm_ppi and tpm_interface != 'tis':
        raise ValueError('PPI candidate requires the tested ARM TIS device')
    return ['qemu-system-aarch64', '-L', '/usr/share/qemu', '-name', 'Team AI Box Windows lab',
            '-machine', 'virt-8.2,gic-version=3', '-accel', 'kvm', '-cpu', 'host', '-smp', '4', '-m', '8192', '-nodefaults',
            '-drive', 'if=pflash,format=raw,readonly=on,file=/usr/share/AAVMF/AAVMF_CODE.ms.fd',
            '-drive', 'if=pflash,format=raw,file='+str(work/'VARS.fd'),
            '-device', 'ramfb', '-device', 'qemu-xhci', '-device', 'usb-kbd', '-device', 'usb-tablet',
            '-drive', 'if=none,id=installer,format=raw,media=cdrom,readonly=on,cache=none,file=/media/windows.iso',
            '-device', 'usb-storage,drive=installer,bootindex=2',
            '-drive', 'if=none,id=drivers,format=raw,media=cdrom,readonly=on,cache=none,file=/media/virtio.iso',
            '-device', 'usb-storage,drive=drivers',
            '-drive', 'if=none,id=system,format=qcow2,cache=none,aio=threads,file='+str(work/'system.qcow2'),
            '-device', 'nvme,drive=system,serial=TABWINDOWSLAB001,bootindex=1',
            '-netdev', 'user,id=net0', '-device', 'virtio-net-pci,netdev=net0,romfile=',
            '-chardev', 'socket,id=tpm,path='+str(run/'swtpm.sock'), '-tpmdev', 'emulator,id=tpmdev,chardev=tpm',
            '-device', 'tpm-'+tpm_interface+'-device,tpmdev=tpmdev'+(',id=vtpm,ppi=on' if tpm_ppi else ''),
            '-serial', 'file:'+str(run/'serial.log'),
            '-qmp', 'unix:'+str(run/'qmp.sock')+',server=on,wait=off', '-vnc', '127.0.0.1:0', '-display', 'none']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--max-seconds', type=int, default=14400)
    parser.add_argument('--tpm-interface', choices=('tis', 'crb'), default='tis')
    parser.add_argument('--tpm-ppi', action='store_true')
    args = parser.parse_args()
    if not 60 <= args.max_seconds <= 14400:
        parser.error('lab runtime must be bounded to four hours or less')
    work, run = Path('/guest'), Path('/tmp/windows-install')
    disable_process_thp()
    run.mkdir()
    with (work/'runtime.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
        prepare_guest(work, args.tpm_interface)
        children = []
        stopping = False
        def request_stop(*_):
            nonlocal stopping
            stopping = True
        signal.signal(signal.SIGTERM, request_stop)
        signal.signal(signal.SIGINT, request_stop)
        qemu = None
        try:
            tpm = subprocess.Popen(['swtpm', 'socket', '--tpm2', '--tpmstate', 'dir='+str(work/'tpm'),
                                    '--ctrl', 'type=unixio,path='+str(run/'swtpm.sock'), '--flags', 'not-need-init'])
            children.append(tpm)
            for _ in range(100):
                if (run/'swtpm.sock').exists():
                    break
                if tpm.poll() is not None:
                    raise RuntimeError('TPM failed to start')
                time.sleep(.05)
            qemu = subprocess.Popen(qemu_args(work, run, args.tpm_interface, args.tpm_ppi))
            children.append(qemu)
            web = subprocess.Popen(['websockify', '--web=/usr/share/novnc', '0.0.0.0:6080', '127.0.0.1:5900'])
            children.append(web)
            print(json.dumps({'event': 'persistent_guest_started', 'diskGiB': 96, 'memoryMiB': 8192,
                              'diskBus': 'nvme', 'network': 'virtio-net-user', 'processThpDisabled': True,
                              'maxSeconds': args.max_seconds}), flush=True)
            deadline = time.monotonic()+args.max_seconds
            while not stopping and time.monotonic() < deadline:
                if qemu.poll() is not None:
                    if qemu.returncode:
                        raise RuntimeError('QEMU exited with failure')
                    print('{"event":"guest_powered_off"}', flush=True)
                    return
                if tpm.poll() is not None or web.poll() is not None:
                    # swtpm can exit just before QEMU finishes a normal guest shutdown.
                    try:
                        if qemu.wait(timeout=3) == 0:
                            print('{"event":"guest_powered_off"}', flush=True)
                            return
                    except subprocess.TimeoutExpired:
                        pass
                    raise RuntimeError('lab component exited before guest shutdown completed')
                time.sleep(1)
        finally:
            if qemu is not None and qemu.poll() is None:
                try:
                    qmp_shutdown(run/'qmp.sock')
                    qemu.wait(timeout=90)
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    print('{"event":"guest_graceful_shutdown_timeout"}', flush=True)
            for child in reversed(children):
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=5)


if __name__ == '__main__':
    main()
