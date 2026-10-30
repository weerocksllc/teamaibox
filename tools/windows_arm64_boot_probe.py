#!/usr/bin/env python3
"""Diskless Windows installer console. No Windows installation or account creation.

Executed inside the lab container. Only the public ISO is mounted; firmware and
TPM state live in tmpfs. The console is published on host loopback via SSH only.
This is not the authenticated product desktop gateway.
"""
import argparse
import json
from pathlib import Path
import shutil
import signal
import subprocess
import time

children = []


def stop(*_):
    raise SystemExit(0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--firmware', choices=('ms', 'standard', 'bios'), default='ms')
    parser.add_argument('--tpm', choices=('tis', 'none'), default='tis')
    parser.add_argument('--serial-log', action='store_true', help='Attach only a guest UART, logging into this temporary container')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    work = Path('/tmp/windows-boot')
    work.mkdir()
    suffix = '.ms' if args.firmware == 'ms' else ''
    shutil.copyfile('/usr/share/AAVMF/AAVMF_VARS' + suffix + '.fd', work / 'VARS.fd')
    # Comparison against the qemu-efi-aarch64 boot form documented by virtio-win.
    # This diskless diagnostic variant does not claim persistent Secure Boot state.
    firmware_args = (['-bios', '/usr/share/qemu-efi-aarch64/QEMU_EFI.fd']
                     if args.firmware == 'bios' else
                     ['-drive', 'if=pflash,format=raw,readonly=on,file=/usr/share/AAVMF/AAVMF_CODE' + suffix + '.fd',
                      '-drive', 'if=pflash,format=raw,file=' + str(work / 'VARS.fd')])
    tpm_args = []
    if args.tpm == 'tis':
        tpm = subprocess.Popen(['swtpm', 'socket', '--tpm2', '--tpmstate', 'dir=' + str(work),
                            '--ctrl', 'type=unixio,path=' + str(work / 'swtpm.sock'),
                            '--flags', 'not-need-init'])
        children.append(tpm)
        for _ in range(100):
            if (work / 'swtpm.sock').exists():
                break
            if tpm.poll() is not None:
                raise RuntimeError('virtual TPM did not start')
            time.sleep(0.05)
        tpm_args = ['-chardev', 'socket,id=tpm,path=' + str(work / 'swtpm.sock'),
                    '-tpmdev', 'emulator,id=tpmdev,chardev=tpm',
                    '-device', 'tpm-tis-device,tpmdev=tpmdev']
    qemu_args = ['qemu-system-aarch64', '-name', 'Windows ARM64 installer probe',
                 '-machine', 'virt-8.2,gic-version=3', '-accel', 'kvm', '-cpu', 'host',
                 '-smp', '4', '-m', '8192', '-nodefaults',
                 *firmware_args,
                 '-device', 'ramfb', '-device', 'qemu-xhci', '-device', 'usb-kbd', '-device', 'usb-tablet',
                 '-drive', 'if=none,id=installer,format=raw,media=cdrom,readonly=on,file=/media/windows.iso',
                 '-device', 'usb-storage,drive=installer,bootindex=1', '-nic', 'none',
                 *tpm_args,
                 *(['-serial', 'file:' + str(work / 'serial.log')] if args.serial_log else []),
                 '-qmp', 'unix:' + str(work / 'qmp.sock') + ',server=on,wait=off',
                 '-vnc', '127.0.0.1:0', '-display', 'none']
    qemu = subprocess.Popen(qemu_args)
    children.append(qemu)
    web = subprocess.Popen(['websockify', '--web=/usr/share/novnc', '0.0.0.0:6080', '127.0.0.1:5900'])
    children.append(web)
    print(json.dumps({'event': 'installer_boot_started', 'guestMiB': 8192, 'vcpus': 4,
                      'firmware': args.firmware, 'tpm': args.tpm, 'serialLog': args.serial_log, 'diskAttached': False,
                      'networkAttached': False, 'maxSeconds': 900}), flush=True)
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        if any(child.poll() is not None for child in children):
            raise RuntimeError('installer probe component exited')
        time.sleep(1)


if __name__ == '__main__':
    try:
        main()
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
