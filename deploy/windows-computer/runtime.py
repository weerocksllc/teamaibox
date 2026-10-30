#!/usr/bin/env python3
"""Container-local Windows runtime. Node Agent owns admission, paths and access.

No guest credentials, host device paths, CLI fragments or public ports are
accepted from a member request. /guest must be an already admitted encrypted
volume; this process does not mount disks or assert that a directory is LUKS.
"""
import argparse
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import threading
import time
import tempfile
import sys

UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')

def validate_config(c):
    keys = {'schemaVersion', 'computerId', 'ownerId', 'nodeId', 'volumeId', 'firmwareId', 'tpmId',
            'runId', 'generation', 'profileId', 'runtimeImage', 'resources', 'firmwareCodeDigest',
            'firmwareVarsDigest', 'mediaDigest', 'driverDigest', 'tpmPpi', 'shutdownSeconds'}
    if isinstance(c, dict) and c.get('schemaVersion') == 2:
        keys |= {'osFamily', 'architecture'}
    if not isinstance(c, dict) or set(c) != keys or type(c['schemaVersion']) is not int or c['schemaVersion'] not in (1, 2):
        raise ValueError('computer_configuration_invalid')
    if c['schemaVersion'] == 2 and (c['osFamily'] not in ('windows', 'linux') or c['architecture'] != 'aarch64'):
        raise ValueError('computer_configuration_invalid')
    for key in ('computerId', 'ownerId', 'nodeId', 'volumeId', 'firmwareId'):
        if not isinstance(c[key], str) or not UUID.fullmatch(c[key]):
            raise ValueError('computer_configuration_invalid')
    for key in ('tpmId', 'runId'):
        if c[key] is not None and (not isinstance(c[key], str) or not UUID.fullmatch(c[key])):
            raise ValueError('computer_configuration_invalid')
    for key in ('runtimeImage', 'firmwareCodeDigest', 'firmwareVarsDigest', 'mediaDigest', 'driverDigest'):
        if c['schemaVersion'] == 2 and key in ('mediaDigest', 'driverDigest') and c[key] is None:
            continue
        if not isinstance(c[key], str) or not DIGEST.fullmatch(c[key]):
            raise ValueError('computer_configuration_invalid')
    if not isinstance(c['profileId'], str) or not re.fullmatch(r'[a-z0-9][a-z0-9._-]*', c['profileId']):
        raise ValueError('computer_configuration_invalid')
    r = c['resources']
    if not isinstance(r, dict) or set(r) != {'vcpus', 'memoryBytes', 'diskBytes'} or any(type(n) is not int or not 0 < n < 2**53 for n in r.values()):
        raise ValueError('computer_resources_invalid')
    if r['memoryBytes'] % (1024**2) or r['diskBytes'] % 512 or type(c['generation']) is not int or not 0 <= c['generation'] < 2**53:
        raise ValueError('computer_resources_invalid')
    if (c['runId'] is None) != (c['generation'] == 0) or type(c['tpmPpi']) is not bool or c['tpmPpi'] and c['tpmId'] is None:
        raise ValueError('computer_configuration_invalid')
    if type(c['shutdownSeconds']) is not int or c['shutdownSeconds'] <= 0:
        raise ValueError('computer_configuration_invalid')
    return c

def atomic_json(path, value):
    pending = path.with_name(path.name + '.pending')
    # Only our directory and deterministic pending file; never overwrite an
    # existing guest disk/firmware as a way to recover a failed write.
    if pending.is_symlink():
        raise RuntimeError('computer_storage_identity_invalid')
    with pending.open('w') as stream:
        os.chmod(pending, 0o600)
        json.dump(value, stream, separators=(',', ':'))
        stream.flush()
        os.fsync(stream.fileno())
    pending.replace(path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def storage_identity(c):
    keys = ('schemaVersion', 'computerId', 'ownerId', 'nodeId', 'volumeId', 'firmwareId', 'tpmId',
            'profileId', 'resources', 'firmwareCodeDigest', 'firmwareVarsDigest', 'tpmPpi')
    # Never reinterpret an existing schema-1 identity. New volumes alone omit
    # removable media from identity; changing media cannot recreate a disk.
    keys += ('mediaDigest', 'driverDigest') if c['schemaVersion'] == 1 else ('osFamily', 'architecture')
    return {k: c[k] for k in keys}

def installer_path(digest, root=Path('/media/installer')):
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        raise ValueError('computer_media_invalid')
    return root / (digest.removeprefix('sha256:') + '.iso')

def regular(path):
    return path.is_file() and not path.is_symlink()

def verify_digest(path, expected):
    if not regular(path):
        raise RuntimeError('computer_profile_unavailable')
    with path.open('rb') as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
        actual = 'sha256:' + digest.hexdigest()
    if actual != expected:
        raise RuntimeError('computer_profile_unavailable')

def verify_storage(c, work):
    identity = work / 'identity.json'
    if not regular(identity) or json.loads(identity.read_text()) != {'phase': 'ready', 'identity': storage_identity(c)}:
        raise RuntimeError('computer_storage_identity_invalid')
    if not all(regular(work / name) for name in ('system.qcow2', 'VARS.fd')):
        raise RuntimeError('computer_storage_identity_invalid')
    if c['tpmId'] is not None and (not (work / 'tpm').is_dir() or (work / 'tpm').is_symlink()):
        raise RuntimeError('computer_storage_identity_invalid')

def prepare_guest(c, work, firmware, command=subprocess.run):
    """Initialize a NEW, already encrypted volume. Caller holds runtime.lock.

    Resume missing files only while the never-started volume is initializing.
    Existing disks are inspected, never replaced. A ready guest is unchanged.
    """
    identity = work / 'identity.json'
    initializing = {'phase': 'initializing', 'identity': storage_identity(c)}
    if identity.exists() or identity.is_symlink():
        if not regular(identity):
            raise RuntimeError('computer_storage_identity_invalid')
        current = json.loads(identity.read_text())
        if current != initializing:
            verify_storage(c, work)
            return
        if any(p.name not in ('runtime.lock', 'identity.json', 'identity.json.pending', 'system.qcow2', 'VARS.fd', 'tpm') for p in work.iterdir()):
            raise RuntimeError('computer_partial_storage_requires_recovery')
    elif any(p.name != 'runtime.lock' for p in work.iterdir()):
        raise RuntimeError('computer_partial_storage_requires_recovery')
    verify_digest(firmware / 'VARS.fd', c['firmwareVarsDigest'])
    atomic_json(identity, initializing)
    disk = work / 'system.qcow2'
    if disk.exists() or disk.is_symlink():
        if not regular(disk):
            raise RuntimeError('computer_storage_identity_invalid')
        info = json.loads(command(['qemu-img', 'info', '--output=json', str(disk)], check=True, capture_output=True, text=True).stdout)
        if info.get('format') != 'qcow2' or info.get('virtual-size') != c['resources']['diskBytes'] or info.get('backing-filename'):
            raise RuntimeError('computer_storage_identity_invalid')
    else:
        command(['qemu-img', 'create', '-f', 'qcow2', str(disk), str(c['resources']['diskBytes'])], check=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    variables = work / 'VARS.fd'
    if variables.exists() or variables.is_symlink():
        verify_digest(variables, c['firmwareVarsDigest'])
    else:
        shutil.copyfile(firmware / 'VARS.fd', variables)
    if c['tpmId'] is not None:
        (work / 'tpm').mkdir(mode=0o700, exist_ok=True)
        if (work / 'tpm').is_symlink():
            raise RuntimeError('computer_storage_identity_invalid')
    # Persist both files before publishing the ready marker.
    for name in ('system.qcow2', 'VARS.fd'):
        os.chmod(work / name, 0o600)
        with (work / name).open('rb') as stream:
            os.fsync(stream.fileno())
    atomic_json(identity, {'phase': 'ready', 'identity': storage_identity(c)})

def qemu_args(c, work, control, *, disc_boot=False, managed_media=False):
    managed_media = managed_media or c['schemaVersion'] == 2
    if disc_boot and (not managed_media or c['mediaDigest'] is None):
        raise ValueError('computer_installation_boot_media_required')
    r = c['resources']
    args = ['qemu-system-aarch64', '-L', '/usr/share/qemu', '-name', 'Team AI Box Windows',
            '-machine', 'virt-8.2,gic-version=3', '-accel', 'kvm', '-cpu', 'host', '-smp', str(r['vcpus']),
            '-m', str(r['memoryBytes'] // (1024**2)), '-nodefaults', '-uuid', c['computerId'],
            '-drive', 'if=pflash,format=raw,readonly=on,file=/firmware/CODE.fd',
            '-drive', 'if=pflash,format=raw,file=' + str(work / 'VARS.fd'),
            '-device', 'ramfb', '-device', 'qemu-xhci', '-device', 'usb-kbd', '-device', 'usb-tablet',
            '-audiodev', 'pa,id=monitor_audio,server=tcp:127.0.0.1:4713,out.name=guest_output,out.frequency=48000,out.channels=2,out.latency=20000',
            '-device', 'usb-audio,audiodev=monitor_audio,multi=off',
            '-drive', 'if=none,id=installer,format=raw,media=cdrom,readonly=on,cache=none,file=/media/windows.iso',
            '-device', 'usb-storage,drive=installer,bootindex=2',
            '-drive', 'if=none,id=drivers,format=raw,media=cdrom,readonly=on,cache=none,file=/media/virtio.iso',
            '-device', 'usb-storage,drive=drivers',
            '-drive', 'if=none,id=system,format=qcow2,cache=none,aio=threads,file=' + str(work / 'system.qcow2'),
            '-device', 'nvme,drive=system,serial=' + c['volumeId'].replace('-', '')[:20] + ',bootindex=1',
            # Private per-computer container network only; Node Agent must not
            # publish these management ports on a host/LAN interface.
            '-netdev', 'user,id=net0,hostfwd=tcp:0.0.0.0:3389-:3389', '-device', 'virtio-net-pci,netdev=net0,romfile=',
            '-qmp', 'unix:' + str(control / 'qmp.sock') + ',server=on,wait=off',
            '-qmp', 'unix:' + str(control / 'qmp-optical.sock') + ',server=on,wait=off',
            '-vnc', '0.0.0.0:0', '-display', 'none', '-serial', 'none']
    if c['tpmId'] is not None:
        args += ['-chardev', 'socket,id=tpm,path=' + str(control / 'swtpm.sock'), '-tpmdev', 'emulator,id=tpmdev,chardev=tpm',
                 '-device', 'tpm-tis-device,tpmdev=tpmdev' + (',id=vtpm,ppi=on' if c['tpmPpi'] else '')]
    if managed_media:
        args[args.index('-name') + 1] = 'Team AI Box Computer'
        installer = args.index('if=none,id=installer,format=raw,media=cdrom,readonly=on,cache=none,file=/media/windows.iso')
        # An empty tray must not specify backend options (format/cache/readonly).
        # media=cdrom keeps it read-only; inserted media uses explicit raw + RO.
        args[installer] = 'if=none,id=installer,media=cdrom'
        if c['mediaDigest'] is not None:
            args[installer] += ',format=raw,readonly=on,cache=none,file=' + str(installer_path(c['mediaDigest']))
        device = args.index('usb-storage,drive=installer,bootindex=2')
        args[device] = 'usb-storage,id=installer-device,drive=installer,removable=on,bootindex=2'
        if disc_boot:
            args[device] = 'usb-storage,id=installer-device,drive=installer,removable=on,bootindex=0'
            args += ['-S']  # Restore the next-reset order and persist consumption before cont.
        if c['driverDigest'] is None:
            driver = args.index('if=none,id=drivers,format=raw,media=cdrom,readonly=on,cache=none,file=/media/virtio.iso')
            del args[driver-1:driver+3]
        if c.get('osFamily') == 'linux':
            args[args.index('user,id=net0,hostfwd=tcp:0.0.0.0:3389-:3389')] = 'user,id=net0'
    return args

# This is an output-only virtual speaker, not the appliance's sound server.
# Its default recording source is the private sink monitor, never a microphone.
PULSE_CONFIG = '''load-module module-null-sink sink_name=guest_output rate=48000 channels=2
set-default-sink guest_output
set-default-source guest_output.monitor
load-module module-native-protocol-tcp listen=127.0.0.1 port=4713 auth-ip-acl=127.0.0.1 auth-anonymous=1
'''

class MonitorAudio:
    def __init__(self):
        self.directory = tempfile.TemporaryDirectory(prefix='computer-audio-')
        self.process = None
        self.retry_at = 0
        self.config = Path(self.directory.name) / 'pulse.pa'
        self.config.write_text(PULSE_CONFIG)

    def ensure_running(self):
        # Audio failure is not permission to kill a live guest or its TPM.
        if self.process is not None and self.process.poll() is None:
            return True
        if time.monotonic() < self.retry_at:
            return False
        self.retry_at = time.monotonic() + 5
        env = {**os.environ, 'HOME': self.directory.name, 'XDG_RUNTIME_DIR': self.directory.name}
        try:
            self.process = subprocess.Popen(['pulseaudio', '--daemonize=no', '--use-pid-file=no',
                '--exit-idle-time=-1', '--disallow-exit=true', '--log-target=stderr', '-n',
                '--file=' + str(self.config)], env=env)
        except OSError:
            return False
        return True

    def wait_ready(self):
        if not self.ensure_running():
            raise RuntimeError('computer_audio_unavailable')
        deadline = time.monotonic() + 10
        while self.process.poll() is None and time.monotonic() < deadline:
            try:
                with socket.create_connection(('127.0.0.1', 4713), timeout=.2):
                    return
            except OSError:
                time.sleep(.05)
        raise RuntimeError('computer_audio_unavailable')

    def close(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.directory.cleanup()

class Qmp:
    """Correlate command replies; a write or POWERDOWN is not a guest shutdown."""
    def __init__(self, path, timeout=5):
        self.socket = socket.socket(socket.AF_UNIX)
        self.socket.settimeout(5)
        try:
            self.socket.connect(str(path))
            self.stream = self.socket.makefile('rwb', buffering=0)
            if 'QMP' not in json.loads(self.stream.readline()):
                raise RuntimeError('computer_qmp_unavailable')
        except Exception:
            self.socket.close()
            raise
        self.closed = False
        self.clean_shutdown = False
        self.powerdown_events = 0
        self.timeout = timeout
        self.sequence = 0
        self.pending = {}
        self.condition = threading.Condition()
        self.lock = threading.Lock()
        self.socket.settimeout(None)
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        try:
            self.send('qmp_capabilities')
        except Exception:
            self.close()
            raise

    def send(self, command, arguments=None):
        if not isinstance(command, str) or arguments is not None and not isinstance(arguments, dict):
            raise ValueError('computer_qmp_command_invalid')
        with self.condition:
            if self.closed:
                raise RuntimeError('computer_qmp_unavailable')
            self.sequence += 1
            identity = self.sequence
            self.pending[identity] = None
        try:
            with self.lock:
                request = {'execute': command, 'id': identity}
                if arguments is not None:
                    request['arguments'] = arguments
                self.stream.write(json.dumps(request).encode() + b'\n')
            with self.condition:
                received = self.condition.wait_for(lambda: self.pending[identity] is not None or self.closed, self.timeout)
                reply = self.pending[identity]
                if reply is None:
                    raise RuntimeError('computer_qmp_reply_timeout' if not received else 'computer_qmp_unavailable')
                if 'error' in reply or 'return' not in reply:
                    # Do not publish arbitrary QMP descriptions (paths/guest data).
                    raise RuntimeError('computer_qmp_command_rejected')
                return reply['return']
        finally:
            with self.condition:
                self.pending.pop(identity, None)

    def read(self):
        try:
            for line in self.stream:
                event = json.loads(line)
                if not isinstance(event, dict):
                    continue
                if event.get('event') == 'SHUTDOWN' and event.get('data', {}).get('guest') is True and event['data'].get('reason') == 'guest-shutdown':
                    self.clean_shutdown = True
                if event.get('event') == 'POWERDOWN':
                    self.powerdown_events += 1
                with self.condition:
                    identity = event.get('id')
                    if type(identity) is int and identity in self.pending:
                        self.pending[identity] = event
                        self.condition.notify_all()
        except (OSError, ValueError):
            pass
        finally:
            with self.condition:
                self.closed = True
                self.condition.notify_all()

    def close(self):
        try:
            self.socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.socket.close()
        self.reader.join(timeout=1)
        if not self.reader.is_alive():
            self.stream.close()

def wait_qmp(path, process, timeout=15, factory=Qmp, retry_interval=.05):
    """Wait for QMP itself, not merely its socket pathname.

    QEMU creates the UNIX socket before its listener is always ready to accept.
    A container restart can therefore observe the path and still receive
    ECONNREFUSED. That is a startup race, not a failed Windows disk.
    """
    deadline = time.monotonic() + timeout
    last = None
    while process.poll() is None and time.monotonic() < deadline:
        try:
            return factory(path)
        except (OSError, RuntimeError, ValueError) as error:
            last = error
            time.sleep(retry_interval)
    if process.poll() is not None:
        raise RuntimeError('computer_qmp_unavailable')
    raise RuntimeError('computer_qmp_unavailable') from last

def request_shutdown(qmp, control, status):
    """Record transport acceptance separately without turning rejection into a kill."""
    error = None
    try:
        qmp.send('system_powerdown')
    except (RuntimeError, OSError) as exc:
        error = str(exc) if str(exc) in ('computer_qmp_reply_timeout', 'computer_qmp_unavailable',
                                        'computer_qmp_command_rejected') else 'computer_qmp_unavailable'
    atomic_json(control / 'shutdown-status.json', {
        **status, 'requestedAtUnixMs': int(time.time() * 1000),
        'commandAccepted': error is None, 'errorCode': error,
        'guestShutdownConfirmed': qmp.clean_shutdown,
    })
    return error

def serve(c, work, control):
    if c['runId'] is None:
        raise ValueError('computer_run_required')
    verify_storage(c, work)
    verify_digest(Path('/firmware/CODE.fd'), c['firmwareCodeDigest'])
    from installation_boot import InstallationLaunch
    installation = InstallationLaunch(c, Path('/run/computer'), control, atomic_json)
    if installation.managed_media and installation.config['mediaDigest'] is not None:
        verify_digest(installer_path(installation.config['mediaDigest']), installation.config['mediaDigest'])
    # Process-scoped THP behavior from the tested runtime; no host sysctl change.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(41, 1, 0, 0, 0) != 0 or libc.prctl(42, 0, 0, 0, 0) != 1:
        raise RuntimeError('computer_process_memory_setup_failed')
    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    children = []
    audio = MonitorAudio()
    qmp = None
    status = {k: c[k] for k in ('computerId', 'ownerId', 'nodeId', 'volumeId', 'firmwareId', 'tpmId', 'runId', 'generation', 'runtimeImage')}
    def publish(phase, clean=False, error=None):
        atomic_json(control / 'status.json', {**status, 'phase': phase, 'cleanShutdown': clean,
                    'errorCode': error, 'updatedAtUnixMs': int(time.time() * 1000)})
    publish('starting')
    try:
        audio.wait_ready()
        if c['tpmId'] is not None:
            tpm = subprocess.Popen(['swtpm', 'socket', '--tpm2', '--tpmstate', 'dir=' + str(work / 'tpm'),
                                    '--ctrl', 'type=unixio,path=' + str(control / 'swtpm.sock'), '--flags', 'not-need-init'])
            children.append(tpm)
            deadline = time.monotonic() + 15
            while not (control / 'swtpm.sock').exists():
                if tpm.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('computer_tpm_unavailable')
                time.sleep(.05)
        qemu = subprocess.Popen(qemu_args(installation.config, work, control, disc_boot=installation.disc_boot, managed_media=installation.managed_media))
        children.append(qemu)
        qmp = wait_qmp(control / 'qmp.sock', qemu)
        installation.release(qmp)
        requested = False
        reconnect_at = 0
        while qemu.poll() is None:
            audio_ready = audio.ensure_running()
            atomic_json(control / 'audio-status.json', {'available': audio_ready,
                'errorCode': None if audio_ready else 'computer_audio_unavailable'})
            if any(child.poll() is not None for child in children if child is not qemu):
                # TPM/QMP may close a moment before QEMU reports guest poweroff.
                try:
                    qemu.wait(timeout=3)
                    break
                except subprocess.TimeoutExpired:
                    raise RuntimeError('computer_runtime_unavailable')
            if qmp.closed and time.monotonic() >= reconnect_at:
                # Losing a monitor connection does not mean Windows is dead.
                # Reconnect without restarting QEMU or releasing its capacity.
                reconnect_at = time.monotonic() + 5
                previous = qmp
                try:
                    qmp = Qmp(control / 'qmp.sock')
                    qmp.clean_shutdown = qmp.clean_shutdown or previous.clean_shutdown
                except (RuntimeError, OSError, ValueError):
                    pass
                finally:
                    previous.close()
            request = control / 'shutdown.json'
            installation.reconcile(qmp)
            if regular(request):
                value = json.loads(request.read_text())
                if value == {'computerId': c['computerId'], 'runId': c['runId'], 'generation': c['generation']}:
                    stopping.set()
            if stopping.is_set() and not requested:
                # Rejected/unanswered commands are diagnostic failures, not
                # permission to terminate a live Windows process or its TPM.
                request_shutdown(qmp, control, status)
                requested = True
                deadline = time.monotonic() + c['shutdownSeconds']
            timed_out = requested and time.monotonic() > deadline
            publish('stopping' if requested else 'running', error='computer_shutdown_timeout' if timed_out else None)
            # There is no max running lifetime. A slow guest shutdown does not
            # become a kill/reinstall, or free capacity while Windows is alive.
            time.sleep(1)
        qmp.reader.join(timeout=1)
        clean = qemu.returncode == 0 and qmp.clean_shutdown
        publish('stopped', clean=clean, error=None if clean else 'computer_unclean_exit')
    except Exception:
        publish('unavailable', error='computer_runtime_unavailable')
        raise
    finally:
        if qmp:
            qmp.close()
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        audio.close()

def optical_command(c, work, control, action, request, *, qmp_factory=Qmp, drive_factory=None):
    if c['runId'] is None or (c['schemaVersion'] != 2 and not (Path('/run/computer') / 'installation-request.json').is_file()):
        raise ValueError('computer_media_runtime_unsupported')
    if action not in ('optical-inspect', 'optical-change') or not isinstance(request, dict):
        raise ValueError('computer_media_request_invalid')
    keys = {'computerId', 'ownerId', 'runId', 'generation'}
    if action == 'optical-change':
        keys |= {'digest'}
    if set(request) != keys or type(request.get('generation')) is not int or any(request[k] != c[k] for k in ('computerId', 'ownerId', 'runId', 'generation')):
        raise ValueError('computer_media_request_invalid')
    if action == 'optical-change' and request['digest'] is not None and (
            not isinstance(request['digest'], str) or not DIGEST.fullmatch(request['digest'])):
        raise ValueError('computer_media_request_invalid')
    verify_storage(c, work)
    if drive_factory is None:
        from optical_drive import OpticalDrive
        drive_factory = OpticalDrive
    # Separate from the lifetime runtime.lock: a media request never stops the
    # guest just to obtain a lock. Cross-process changes are serialized here;
    # ownership/revision/operation admission remains the persistent API's job.
    with (control / 'optical.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # QEMU accepts one active client per QMP listener. The lifetime monitor
        # owns qmp.sock; media operations need their own serialized listener.
        qmp = qmp_factory(control / 'qmp-optical.sock')
        try:
            drive = drive_factory(qmp)
            value = drive.inspect() if action == 'optical-inspect' else drive.change(request['digest'])
            return {**{k: c[k] for k in ('computerId', 'ownerId', 'runId', 'generation')}, 'optical': value}
        finally:
            qmp.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('provision', 'serve', 'verify-profile', 'optical-inspect', 'optical-change'))
    args = parser.parse_args()
    c = validate_config(json.loads(Path('/run/computer/config.json').read_text()))
    work, control = Path('/guest'), Path('/control')
    if args.action.startswith('optical-'):
        raw = sys.stdin.read(4097)
        if len(raw) > 4096:
            raise ValueError('computer_media_request_invalid')
        print(json.dumps(optical_command(c, work, control, args.action, json.loads(raw))))
        return
    if args.action == 'verify-profile':
        for path, key in [('/firmware/CODE.fd', 'firmwareCodeDigest'), ('/firmware/VARS.fd', 'firmwareVarsDigest'),
                          ('/media/windows.iso', 'mediaDigest'), ('/media/virtio.iso', 'driverDigest')]:
            if c['schemaVersion'] == 2 and key in ('mediaDigest', 'driverDigest'):
                if c[key] is None:
                    continue
                if key == 'mediaDigest':
                    path = installer_path(c[key])
            verify_digest(Path(path), c[key])
        return
    with (work / 'runtime.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'provision':
            prepare_guest(c, work, Path('/firmware'))
        else:
            serve(c, work, control)

if __name__ == '__main__':
    main()
