"""Diskless KVM/PPI candidate probe; no claim about Windows or guest firmware."""
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time


def wait_socket(path, process):
    for _ in range(200):
        if path.exists():
            return
        if process.poll() is not None:
            raise RuntimeError(process.stderr.read().decode()[:2000])
        time.sleep(.05)
    raise RuntimeError('probe socket timeout')


def main():
    children = []
    report = {'windowsTpmAccepted': False,
              'sourceVersion': Path('/usr/local/share/qemu-source-version').read_text().strip(),
              'sourceSha256': Path('/usr/local/share/qemu-source-sha256').read_text().split()[0],
              'releaseSignerFingerprint': 'CEACC9E15534EBABB82D3FA03353C9CEF108B584'}
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)
        (work / 'tpm').mkdir()
        try:
            tpm = subprocess.Popen(['swtpm', 'socket', '--tpm2', '--tpmstate', 'dir=' + str(work / 'tpm'),
                                    '--ctrl', 'type=unixio,path=' + str(work / 'tpm.sock'),
                                    '--flags', 'not-need-init'], stderr=subprocess.PIPE)
            children.append(tpm)
            wait_socket(work / 'tpm.sock', tpm)
            qemu = subprocess.Popen(['qemu-system-aarch64', '-L', '/usr/share/qemu',
                '-machine', 'virt-8.2', '-accel', 'kvm', '-cpu', 'host', '-smp', '1', '-m', '256M',
                '-S', '-nodefaults', '-display', 'none', '-device', 'ramfb', '-vnc', '127.0.0.1:0',
                '-chardev', 'socket,id=tpm,path=' + str(work / 'tpm.sock'),
                '-tpmdev', 'emulator,id=tpm0,chardev=tpm', '-device', 'tpm-tis-device,id=vtpm,tpmdev=tpm0,ppi=on',
                '-qmp', 'unix:' + str(work / 'qmp.sock') + ',server=on,wait=off'], stderr=subprocess.PIPE)
            children.append(qemu)
            wait_socket(work / 'qmp.sock', qemu)
            with socket.socket(socket.AF_UNIX) as sock:
                sock.settimeout(10)
                sock.connect(str(work / 'qmp.sock'))
                stream = sock.makefile('rwb', buffering=0)
                report['greeting'] = json.loads(stream.readline())
                commands = [('qmp_capabilities', {}), ('query-kvm', {}), ('query-tpm', {}),
                            ('query-vnc', {}), ('qom-get', {'path': '/machine/peripheral/vtpm', 'property': 'ppi'})]
                for command, arguments in commands:
                    stream.write(json.dumps({'execute': command, 'arguments': arguments}).encode() + b'\n')
                    while True:
                        reply = json.loads(stream.readline())
                        if 'event' not in reply:
                            break
                    if 'error' in reply:
                        raise RuntimeError(str(reply['error']))
                    report[command] = reply['return']
            assert report['query-kvm'] == {'enabled': True, 'present': True}
            assert report['query-tpm'][0]['model'] == 'tpm-tis'
            assert report['qom-get'] is True and report['query-vnc']['enabled'] is True
            report['status'] = 'passed'
        finally:
            for child in reversed(children):
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=5)
    print(json.dumps(report))


if __name__ == '__main__':
    main()
