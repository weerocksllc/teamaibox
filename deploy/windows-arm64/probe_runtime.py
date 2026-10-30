"""Bounded KVM probe, no disk or network, guest starts paused and is destroyed on exit."""
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time


def cmd(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=15).stdout


def probe():
    tpm_help = subprocess.run(['qemu-system-aarch64', '-tpmdev', 'help'],
                              capture_output=True, text=True, timeout=15)
    # QEMU's help handler intentionally exits 1 for -tpmdev help.
    tpm_text = tpm_help.stdout + tpm_help.stderr
    if 'emulator' not in tpm_text or tpm_help.returncode not in (0, 1):
        raise RuntimeError('QEMU TPM emulator backend unavailable')
    result = {'qemuVersion': cmd(['qemu-system-aarch64', '--version']).splitlines()[0],
              'machines': cmd(['qemu-system-aarch64', '-machine', 'help']),
              'accelerators': cmd(['qemu-system-aarch64', '-accel', 'help']),
              'tpmDevices': tpm_text,
              'swtpmVersion': cmd(['swtpm', '--version']).splitlines()[0],
              'packages': Path('/usr/local/share/windows-runtime-packages.txt').read_text(),
              'firmware': []}
    for folder in ('/usr/share/AAVMF', '/usr/share/qemu-efi-aarch64'):
        for path in sorted(Path(folder).glob('*.fd')):
            result['firmware'].append({'path': str(path), 'bytes': path.stat().st_size,
                                      'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    with tempfile.TemporaryDirectory() as work:
        address = str(Path(work) / 'qmp.sock')
        args = ['qemu-system-aarch64', '-machine', 'virt', '-accel', 'kvm', '-cpu', 'host',
                '-smp', '1', '-m', '256M', '-S', '-nodefaults', '-display', 'none',
                '-qmp', 'unix:' + address + ',server=on,wait=off']
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            for _ in range(100):
                if Path(address).exists():
                    break
                if proc.poll() is not None:
                    raise RuntimeError('QEMU failed: ' + proc.stderr.read()[:1000])
                time.sleep(0.05)
            with socket.socket(socket.AF_UNIX) as sock:
                sock.settimeout(10)
                sock.connect(address)
                stream = sock.makefile('rwb')
                greeting = json.loads(stream.readline())
                for request in ('qmp_capabilities', 'query-kvm', 'query-status'):
                    stream.write((json.dumps({'execute': request}) + '\n').encode())
                    stream.flush()
                    while True:
                        reply = json.loads(stream.readline())
                        if 'event' not in reply:
                            break
                    if 'error' in reply:
                        raise RuntimeError(str(reply['error']))
                    result[request] = reply['return']
                result['qmpVersion'] = greeting['QMP']['version']
            if result['query-kvm'] != {'enabled': True, 'present': True}:
                raise RuntimeError('real KVM acceleration required')
            result['status'] = 'passed'
            result['windowsBootTested'] = False
            return result
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)


if __name__ == '__main__':
    print(json.dumps(probe()))
