#!/usr/bin/env python3
"""Fixed phone file/APK worker; private stdin/stdout, not an HTTP/ADB server.

The Node Agent must validate its exact container/run before invoking this fixed
program. This worker repeats the run fence, stages only in the encrypted phone
exchange, and accepts no host paths, shell commands or debug grants.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import selectors
import shlex
import stat
import subprocess
import signal
import sys
import time
import unicodedata

from phone_runtime import UUID, PhoneError, closed_json, validate_config
try:
    from services.media_io.resources import buffered_bytes
except ModuleNotFoundError:
    from media_resources import buffered_bytes

MAXIMUM = 2**53 - 1
CHUNK = 65536
END = b'\nTEAMAIBOX-FILE-END\n'
IDENTITY = ('phoneId', 'ownerId', 'runId', 'generation')


def file_name(value):
    if (not isinstance(value, str) or not value or value != value.strip()
            or len(value.encode('utf-8')) > 240 or value in ('.', '..')
            or any(c in '/\\' or unicodedata.category(c) in ('Cc', 'Cf') for c in value)):
        raise PhoneError('phone_input_invalid')
    normalized = unicodedata.normalize('NFC', value)
    if normalized.startswith('.transfer-'):
        raise PhoneError('phone_input_invalid')
    return normalized


def request(value, config, now=None):
    now = time.time() if now is None else now
    basic = {*IDENTITY, 'action', 'transferId', 'deadline'}
    action = value.get('action') if isinstance(value, dict) else None
    extras = {'name', 'sizeBytes', 'sha256'} if action in ('upload', 'install') else {'name'} if action == 'download' else set()
    if not isinstance(value, dict) or action not in ('upload', 'install', 'download', 'list') or set(value) != basic | extras:
        raise PhoneError('phone_input_invalid')
    if (any(value[k] != config[k] for k in IDENTITY) or type(value['generation']) is not int
            or not isinstance(value['transferId'], str) or not UUID.fullmatch(value['transferId'])):
        raise PhoneError('phone_stale_run')
    if type(value['deadline']) is not int or not 0 < value['deadline'] - now*1000 <= 120000:
        raise PhoneError('phone_grant_invalid')
    result = dict(value)
    if 'name' in extras:
        result['name'] = file_name(value['name'])
    if action in ('upload', 'install'):
        if type(value['sizeBytes']) is not int or value['sizeBytes'] < 1:
            raise PhoneError('phone_input_invalid')
        if value['sizeBytes'] > MAXIMUM:
            raise PhoneError('phone_upload_too_large')
        if (not isinstance(value['sha256'], str) or len(value['sha256']) != 64
                or any(c not in '0123456789abcdef' for c in value['sha256'])):
            raise PhoneError('phone_object_invalid')
    return result


# cd pins the opened Android directory. /sdcard itself is Android's expected
# emulated-storage alias; descendants must not be links. No host path is used.
DIRECTORY = '''set -eu
umask 077
cd /sdcard
base=$(pwd -P)
[ ! -L Download ]
mkdir -p Download
[ ! -L Download/TeamAIBox ]
mkdir -p Download/TeamAIBox
cd -P Download/TeamAIBox
[ "$(pwd -P)" = "$base/Download/TeamAIBox" ]
'''


class PhoneFiles:
    def __init__(self, config, data=Path('/phone'), base=Path('/opt/cuttlefish'), *, cancelled=lambda: False, progress=lambda: None):
        self.config = validate_config(config)
        self.data, self.base, self.cancelled = data, base, cancelled
        self.progress = progress
        self.serial = '127.0.0.1:'+str(6519+config['instance'])

    def _check(self, deadline):
        if self.cancelled():
            raise PhoneError('phone_grant_invalid')
        self.progress()

    def _run(self, script, directory, deadline, *, input_file=None, binary=False):
        """Only internally constructed Android commands; bounded pipe reads."""
        self._check(deadline)
        output = directory / 'output'
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        child = None
        total = 0
        diagnostic = bytearray()
        try:
            child = subprocess.Popen([str(self.base/'bin/adb'), '-s', self.serial, 'shell', '-T', script],
                                     stdin=input_file or subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            with selectors.DefaultSelector() as selected:
                for stream in (child.stdout, child.stderr):
                    os.set_blocking(stream.fileno(), False)
                    selected.register(stream, selectors.EVENT_READ)
                while selected.get_map():
                    self._check(deadline)
                    for key, _ in selected.select(.1):
                        chunk = os.read(key.fileobj.fileno(), CHUNK)
                        if not chunk:
                            selected.unregister(key.fileobj)
                        elif key.fileobj is child.stdout:
                            total += len(chunk)
                            if total > (MAXIMUM if binary else 65536):
                                raise PhoneError('phone_upload_too_large')
                            remaining = memoryview(chunk)
                            while remaining:
                                remaining = remaining[os.write(fd, remaining):]
                        else:
                            diagnostic.extend(chunk)
                            if len(diagnostic) > 16384:
                                raise PhoneError('phone_runtime_unavailable')
                while child.poll() is None:
                    self._check(deadline)
                    time.sleep(.1)
            if child.returncode:
                if b'No space left' in diagnostic:
                    raise PhoneError('phone_storage_full')
                raise PhoneError('phone_install_failed' if script.startswith('cmd package install ') else 'phone_object_invalid')
            os.fsync(fd)
            return output
        finally:
            diagnostic[:] = b'\0' * len(diagnostic)
            os.close(fd)
            if child is not None:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=5)
                child.stdout.close()
                child.stderr.close()

    def execute(self, value, incoming, consume_output=lambda metadata, content: metadata):
        job = request(value, self.config)
        deadline = time.monotonic() + (job['deadline']-time.time()*1000)/1000
        exchange = self.data / 'exchange'
        info = exchange.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise PhoneError('phone_storage_unavailable')
        root = os.open(exchange, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        lock = None
        folder = None
        try:
            lock = os.open('.file-transfer.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=root)
            lock_info = os.fstat(lock)
            if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.geteuid() or lock_info.st_mode & 0o077:
                raise PhoneError('phone_storage_unavailable')
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise PhoneError('phone_operation_conflict') from None
            candidate = 'transfer-'+job['transferId']
            os.mkdir(candidate, 0o700, dir_fd=root)  # Never adopt an old/foreign directory.
            folder = candidate
            directory = exchange / folder
            source = None
            if job['action'] in ('upload', 'install'):
                source = directory / 'input'
                sha = hashlib.sha256()
                with source.open('xb') as out:
                    os.chmod(source, 0o600)
                    remaining = job['sizeBytes']
                    while remaining:
                        self._check(deadline)
                        chunk = incoming.read(min(CHUNK, remaining))
                        if not chunk:
                            raise PhoneError('phone_object_invalid')
                        out.write(chunk); sha.update(chunk); remaining -= len(chunk)
                    if incoming.read(len(END)) != END or incoming.read(1) != b'' or sha.hexdigest() != job['sha256']:
                        raise PhoneError('phone_object_invalid')
                    out.flush(); os.fsync(out.fileno())
            self._check(deadline)
            binding = {k:self.config[k] for k in ('phoneId', 'runId', 'generation')}
            if job['action'] == 'install':
                # Android's package manager consumes the APK directly; no -g,
                # test-only permission bypass, shell argument or guest temp APK.
                with source.open('rb') as stream:
                    output = self._run('cmd package install -r -S '+str(job['sizeBytes'])+' -- -', directory, deadline, input_file=stream)
                if output.read_bytes().strip() != b'Success':
                    raise PhoneError('phone_install_failed')
                return binding | {'installed':True, 'sizeBytes':job['sizeBytes'], 'sha256':job['sha256']}
            if job['action'] == 'upload':
                name = shlex.quote(job['name'])
                temporary = '.transfer-'+job['transferId']
                script = DIRECTORY + '\n'.join([
                    'name='+name, 'temporary='+shlex.quote(temporary),
                    '[ ! -e "$name" ] && [ ! -L "$name" ]',
                    "trap 'rm -f -- \"$temporary\"' EXIT", 'set -C', 'exec 3>"$temporary"',
                    'cat >&3', 'exec 3>&-', 'sync', 'mv -nT -- "$temporary" "$name"',
                    '[ ! -e "$temporary" ]', '[ ! -L "$name" ]', 'sha256sum -- "$name"'])
                with source.open('rb') as stream:
                    output = self._run(script, directory, deadline, input_file=stream)
                if output.read_bytes().split(maxsplit=1)[0:1] != [job['sha256'].encode()]:
                    raise PhoneError('phone_object_invalid')
                return binding | {'stored':True, 'name':job['name'], 'sizeBytes':job['sizeBytes'], 'sha256':job['sha256']}
            if job['action'] == 'list':
                script = DIRECTORY + '''
for path in ./*; do
 [ -f "$path" ] && [ ! -L "$path" ] || continue
 printf '%s\\0%s\\0' "$(stat -c %s -- "$path")" "${path#./}"
done
'''
                listed = self._run(script, directory, deadline, binary=True)
                if listed.stat().st_size > buffered_bytes():
                    raise PhoneError('phone_runtime_unavailable')
                parts = listed.read_bytes().split(b'\0')
                if parts[-1] != b'' or len(parts) % 2 != 1:
                    raise PhoneError('phone_object_invalid')
                files=[]
                for offset in range(0, len(parts)-1, 2):
                    name=file_name(parts[offset+1].decode('utf-8'))
                    size=int(parts[offset])
                    if not 0 <= size <= MAXIMUM:
                        raise PhoneError('phone_upload_too_large')
                    files.append({'name':name, 'sizeBytes':size})
                return binding | {'files':files}
            # Pin the opened guest file before reading. A link or renamed path
            # cannot redirect the open descriptor to another guest directory.
            script = DIRECTORY + '\n'.join(['name='+shlex.quote(job['name']), '[ -f "$name" ] && [ ! -L "$name" ]',
                # Android mksh closes its private fd 3 in the readlink child;
                # /proc/self there is that child, not the shell that opened it.
                'exec 3<"$name"', '[ "$(readlink -f /proc/$$/fd/3)" = "$(pwd -P)/$name" ]', 'cat <&3'])
            output = self._run(script, directory, deadline, binary=True)
            sha=hashlib.sha256()
            with output.open('rb') as stream:
                while chunk:=stream.read(CHUNK):
                    self._check(deadline); sha.update(chunk)
                stream.seek(0)
                return consume_output(binding | {'name':job['name'], 'sizeBytes':output.stat().st_size, 'sha256':sha.hexdigest()}, stream)
        finally:
            if folder is not None:
                # Only these two fixed files in the newly-created private dir.
                for name in ('input', 'output'):
                    try: os.unlink(folder+'/'+name, dir_fd=root)
                    except FileNotFoundError: pass
                try: os.rmdir(folder, dir_fd=root)
                except FileNotFoundError: pass
            if lock is not None: os.close(lock)
            os.close(root)


def main():
    def interrupted(*_):
        raise PhoneError('phone_grant_invalid')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.setitimer(signal.ITIMER_REAL, 5)
    try:
        config=validate_config(closed_json(Path('/run/phone/config.json').read_bytes()))
        raw=sys.stdin.buffer.readline(8193)
        if len(raw)>8192 or not raw.endswith(b'\n'):
            raise PhoneError('phone_input_invalid')
        job=request(closed_json(raw),config)
        signal.setitimer(signal.ITIMER_REAL,30)
        emitted=False
        last_progress=0.0
        def progress():
            nonlocal last_progress
            signal.setitimer(signal.ITIMER_REAL,30)
            if not emitted and time.monotonic()-last_progress >= 5:
                value={k:config[k] for k in ('phoneId','runId','generation')}
                print(json.dumps(value|{'transferId':job['transferId'],'progress':True}),flush=True)
                last_progress=time.monotonic()
        def download(metadata, stream):
            nonlocal emitted
            emitted=True
            sys.stdout.buffer.write(json.dumps(metadata|{'transferId':job['transferId']}).encode()+b'\n')
            while chunk:=stream.read(CHUNK):
                progress();sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.write(END);sys.stdout.buffer.flush();emitted=True
            return metadata
        result=PhoneFiles(config,progress=progress).execute(job,sys.stdin.buffer,download)
        if not emitted:
            print(json.dumps(result|{'transferId':job['transferId']}),flush=True)
        return 0
    except Exception as error:
        # No payload, app output, path or exception traceback crosses this API.
        code=str(error) if isinstance(error,PhoneError) else 'phone_runtime_unavailable'
        print(json.dumps({'errorCode':code}),flush=True)
        return 1
    finally: signal.setitimer(signal.ITIMER_REAL,0)


if __name__=='__main__': raise SystemExit(main())
