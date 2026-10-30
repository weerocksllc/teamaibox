"""Disposable QEMU-only probe for the installation bootindex mechanism.

Run inside the already-installed ARM64 runtime image with /dev/kvm and a
private /tmp. No host volume, existing guest, firmware or network is needed.
This proves QEMU's fw_cfg/reset behavior, NOT an OS installation.
"""
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import hashlib
import sys


def connect(path, process):
    deadline = time.monotonic()+10
    while time.monotonic() < deadline:
        sock = socket.socket(socket.AF_UNIX)
        try:
            sock.connect(str(path))
            sock.settimeout(5)
            return sock.makefile('rwb', buffering=0), sock
        except OSError:
            sock.close()
            if process.poll() is not None:
                raise RuntimeError('disposable QEMU exited')
            time.sleep(.05)
    raise RuntimeError('disposable QEMU socket timeout')


def main():
    with tempfile.TemporaryDirectory(prefix='installation-boot-') as temporary:
        root = Path(temporary)
        for name in ('system.raw', 'installer.iso'):
            with (root/name).open('xb') as stream:
                stream.truncate(1024*1024)
        digest = 'sha256:'+hashlib.sha256((root/'installer.iso').read_bytes()).hexdigest()
        installer = root/(digest[7:]+'.iso')
        (root/'installer.iso').rename(installer)
        args = ['qemu-system-aarch64', '-machine', 'virt-8.2', '-accel', 'kvm', '-cpu', 'host',
                '-m', '128', '-S', '-nodefaults', '-display', 'none', '-serial', 'none',
                '-device', 'qemu-xhci,id=xhci',
                '-drive', 'if=none,id=installer,format=raw,media=cdrom,readonly=on,file='+str(installer),
                '-device', 'usb-storage,id=installer-device,drive=installer,removable=on,bootindex=0',
                '-drive', 'if=none,id=system,format=raw,file='+str(root/'system.raw'),
                '-device', 'nvme,id=system-device,drive=system,serial=installation-probe,bootindex=1',
                '-qmp', 'unix:'+str(root/'qmp.sock')+',server=on,wait=off',
                '-qtest', 'unix:'+str(root/'qtest.sock')+',server=on,wait=off', '-qtest-log', '/dev/null']
        process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        streams, sockets = [], []
        try:
            qmp, qmp_socket = connect(root/'qmp.sock', process)
            streams.append(qmp); sockets.append(qmp_socket)
            assert 'QMP' in json.loads(qmp.readline())
            sequence = 0
            def command(name, arguments=None):
                nonlocal sequence
                sequence += 1
                qmp.write(json.dumps({'execute': name, 'arguments': arguments or {}, 'id': sequence}).encode()+b'\n')
                while True:
                    reply = json.loads(qmp.readline())
                    if reply.get('id') == sequence:
                        if 'error' in reply:
                            raise RuntimeError(json.dumps(reply['error']))
                        return reply['return']
            command('qmp_capabilities')
            qtest, qtest_socket = connect(root/'qtest.sock', process)
            streams.append(qtest); sockets.append(qtest_socket)
            def qt(line):
                qtest.write(line.encode()+b'\n')
                while True:
                    reply = qtest.readline().decode().strip()
                    if reply.startswith('OK'):
                        return reply.split()[1:]
                    if not reply.startswith('IRQ '):
                        raise RuntimeError(reply)
            def select(value):
                qt('write 0x9020008 2 0x'+value.to_bytes(2, 'big').hex())
            def read(count):
                return bytes(int(qt('readb 0x9020000')[0], 16) for _ in range(count))
            def bootorder():
                select(0x19)
                count = int.from_bytes(read(4), 'big')
                assert 0 < count < 1024, count
                for _ in range(count):
                    entry = read(64)
                    if entry[8:].split(b'\0')[0] == b'bootorder':
                        length, index = int.from_bytes(entry[:4], 'big'), int.from_bytes(entry[4:6], 'big')
                        assert length < 4096
                        select(index)
                        return read(length).rstrip(b'\0').decode()
                raise RuntimeError('bootorder file absent')
            first = bootorder()
            assert 'usb' in first.splitlines()[0] and '/namespace@' in first, first
            command('qom-set', {'path': '/machine/peripheral/installer-device', 'property': 'bootindex', 'value': 2})
            assert command('qom-get', {'path': '/machine/peripheral/installer-device', 'property': 'bootindex'}) == 2
            before_reset = bootorder()
            assert before_reset == first, (first, before_reset)
            command('system_reset')  # Only this isolated, paused probe machine.
            after_reset = bootorder()
            assert '/namespace@' in after_reset.splitlines()[0] and 'usb' in after_reset, after_reset
            blocks = command('query-block')
            optical = next(b for b in blocks if b['device'] == 'installer')
            assert optical['inserted']['file'] == str(installer)
            print(json.dumps({'installerBlockBackend': optical.get('device'), 'installerDevicePath': optical.get('qdev')}))
            optical_result = None
            if Path('/opt/probe/optical_drive.py').is_file():
                sys.path.insert(0, '/opt/probe')
                from optical_drive import OpticalDrive
                class Adapter:
                    lose_reply = False
                    changes = 0
                    def send(self, name, arguments=None):
                        result = command(name, arguments)
                        if name == 'blockdev-change-medium':
                            self.changes += 1
                            if self.lose_reply:
                                self.lose_reply = False
                                raise RuntimeError('lost change reply')
                        return result
                adapter = Adapter()
                drive = OpticalDrive(adapter, root)
                assert drive.inspect()['digest'] == digest
                content = b'second installation disc'+bytes(1024*1024)
                second = 'sha256:'+hashlib.sha256(content).hexdigest()
                (root/(second[7:]+'.iso')).write_bytes(content)
                assert drive.change(second)['digest'] == second
                assert drive.change(None)['digest'] is None
                adapter.lose_reply = True
                assert drive.change(digest)['digest'] == digest
                assert adapter.changes == 2
                assert drive.change(digest)['digest'] == digest
                assert adapter.changes == 2  # A reconciled replay does not mutate QEMU again.
                assert command('query-status')['running'] is False
                optical_result = {'replace': True, 'eject': True, 'lostReplyReconciled': True,
                                  'idempotentReplay': True, 'guestStartedOrResetByAdapter': False}
            print(json.dumps({'probe': 'installation-bootindex-reset', 'qemu': command('query-version'),
                              'firstBoot': first, 'beforeReset': before_reset, 'afterReset': after_reset,
                              'discRetained': True, 'existingGuestsTouched': False, 'osInstallationVerified': False}))
            if optical_result:
                print(json.dumps({'opticalAdapter': optical_result}))
            command('quit')
        finally:
            for stream in streams:
                stream.close()
            for sock in sockets:
                sock.close()
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=10)
            if process.returncode not in (0, -15):
                raise RuntimeError(process.stderr.read().decode()[-2000:])
            process.stderr.close()


if __name__ == '__main__':
    main()
