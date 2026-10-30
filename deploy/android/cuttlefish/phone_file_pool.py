#!/usr/bin/env python3
"""One-shot root maintenance for an approved file-backed phone pool.

Not an HTTP service and not callable with member paths or Docker arguments.
The operator installs one local appliance plan alongside this script.
Keys stay in an already mounted encrypted filesystem on this same appliance.
There is no remote role, SSH operation, key export, or key input over stdin.
"""
from __future__ import annotations

import argparse
import contextlib
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import socket
import stat
import subprocess
import sys
import uuid

GIB = 1024**3
POOL_BASE = Path('/var/lib/teamaibox/phone-pools')
MOUNT_BASE = Path('/srv/teamaibox/phone-pools')


class PoolError(RuntimeError):
    pass


def need(ok, code):
    if not ok:
        raise PoolError(code)


def command(args, *, pass_fds=(), timeout=90):
    # Never echo argv or stderr: a future crypto diagnostic must not expose a key.
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False, pass_fds=pass_fds)
    need(result.returncode == 0, 'command_failed_' + Path(args[0]).name)
    return result.stdout.decode().strip()


def no_links(path: Path):
    need(path.is_absolute() and str(path) == os.path.normpath(path), 'path_invalid')
    for part in reversed([path, *path.parents]):
        if part.exists() or part.is_symlink():
            need(not part.is_symlink(), 'path_symlink_rejected')


def private_dir(path: Path):
    no_links(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    s = path.stat()
    need(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and s.st_mode & 0o077 == 0,
         'private_directory_required')


def exclusive_json(path, value):
    no_links(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        # Keep even an incomplete declaration for diagnosis; never silently replace.
        raise


def validate_plan(p):
    need(isinstance(p, dict) and p.get('schemaVersion') == 2
         and not {'node', 'custody', 'sshTarget', 'primaryHost'} & set(p), 'local_plan_required')
    need(str(uuid.UUID(p['poolId'])) == p['poolId'], 'plan_invalid')
    capacity, quota = p['capacityBytes'], p['phoneQuotaBytes']
    # LUKS metadata needs space before the ext4 filesystem. This is a format
    # minimum, not a fixed product allocation or device-count limit.
    need(type(capacity) is int and capacity > 32*1024**2 and capacity % 4096 == 0
         and type(quota) is int and 0 < quota < capacity and quota % 4096 == 0, 'capacity_invalid')
    need(p['authorization'] == dict(filePoolCreationApproved=True, physicalDiskEraseApproved=False,
         repartitionApproved=False, nodeRebootApproved=False), 'authorization_invalid')
    host = p['appliance']
    need(isinstance(host, dict) and set(host) == {'hostname', 'rootFilesystemUUID'}
         and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,252}', host['hostname'])
         and str(uuid.UUID(host['rootFilesystemUUID'])) == host['rootFilesystemUUID'], 'host_invalid')
    store = p['keyStore']
    need(isinstance(store, dict) and set(store) == {'encryptedRoot', 'filesystemUUID', 'mapper'}
         and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', store['mapper'])
         and str(uuid.UUID(store['filesystemUUID'])) == store['filesystemUUID'], 'key_store_invalid')
    root = Path(store['encryptedRoot'])
    need(root.is_absolute() and root != Path('/') and str(root) == os.path.normpath(root)
         and '..' not in root.parts and root != MOUNT_BASE and MOUNT_BASE not in root.parents,
         'key_store_path_invalid')
    return p


def plan_read(path):
    no_links(path)
    s = path.stat()
    need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_mode & 0o022 == 0
         and s.st_nlink == 1 and s.st_size < 8192, 'plan_not_root_owned')
    return validate_plan(json.loads(path.read_text()))


def paths(p):
    base = POOL_BASE / p['poolId']
    return base, base/'pool.luks2', MOUNT_BASE/p['poolId'], 'teamaibox-phone-' + p['poolId']


def host_check(p):
    host = p['appliance']
    need(socket.gethostname() == host['hostname'], 'wrong_host')
    need(command(['findmnt', '-n', '-o', 'UUID', '/']) == host['rootFilesystemUUID'],
         'root_filesystem_identity_changed')


def key_store_root(p):
    host_check(p)
    store = p['keyStore']
    root = Path(store['encryptedRoot'])
    no_links(root)
    need(command(['findmnt', '-n', '-o', 'UUID', '--target', str(root)]) == store['filesystemUUID'],
         'local_encrypted_key_store_unavailable')
    need(command(['findmnt', '-n', '-o', 'SOURCE', '--target', str(root)]) == '/dev/mapper/'+store['mapper'],
         'local_encrypted_key_store_unavailable')
    need(re.search(r'type:\s+LUKS2\b', command(['cryptsetup', 'status', store['mapper']])), 'key_store_not_luks2')
    target = root/'phone-pool-keys'/p['poolId']
    no_links(target)
    return target


def key_path(p):
    key = key_store_root(p)/'unlock.key'
    no_links(key)
    s = key.stat()
    need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_mode & 0o077 == 0
         and s.st_size == 64 and s.st_nlink == 1, 'local_key_invalid')
    return key


def key_material(p, action):
    root = key_store_root(p)
    if action == 'key-create':
        private_dir(root)
        fd = os.open(root/'unlock.key', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(os.getrandom(64))
            stream.flush()
            os.fsync(stream.fileno())
    need(action in ('key-create', 'key-inspect', 'header-save'), 'key_action_invalid')
    key_path(p)
    if action == 'header-save':
        inspect_pool(p)
        header = root/'luks2.header'
        no_links(header)
        need(not header.exists(), 'header_already_exists')
        command(['cryptsetup', 'luksHeaderBackup', str(paths(p)[1]), '--header-backup-file', str(header)])
    return {'poolId': p['poolId'], 'keyBytes': 64, 'localEncryptedKeyStore': True,
            'filesystemUUID': p['keyStore']['filesystemUUID'],
            'headerSaved': (root/'luks2.header').is_file()}


@contextlib.contextmanager
def local_key(p):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    key = key_path(p)
    buf = bytearray(64)
    area = (ctypes.c_char*64).from_buffer(buf)
    libc = ctypes.CDLL(None, use_errno=True)
    need(libc.mlock(ctypes.byref(area), ctypes.c_size_t(64)) == 0, 'key_memory_lock_failed')
    fd = None
    source = None
    try:
        source = os.open(key, os.O_RDONLY | os.O_NOFOLLOW)
        info = os.fstat(source)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o077 == 0
             and info.st_size == 64 and info.st_nlink == 1, 'local_key_changed')
        with os.fdopen(source, 'rb') as stream:
            source = None
            need(stream.readinto(buf) == 64 and not stream.read(1), 'key_length_invalid')
        fd = os.memfd_create('phone-pool-key', os.MFD_CLOEXEC)
        os.write(fd, buf)
        os.lseek(fd, 0, os.SEEK_SET)
        yield fd
    finally:
        if source is not None:
            os.close(source)
        if fd is not None:
            os.lseek(fd, 0, os.SEEK_SET)
            os.write(fd, b'\0'*64)
            os.close(fd)
        buf[:] = b'\0'*64
        libc.munlock(ctypes.byref(area), ctypes.c_size_t(64))


def crypt(p, verb, fd):
    _, backing, _, mapper = paths(p)
    flags = ['--key-file', f'/proc/self/fd/{fd}']
    if verb == 'format':
        args = ['cryptsetup', 'luksFormat', '--type', 'luks2', '--batch-mode', '--cipher', 'aes-xts-plain64',
                '--key-size', '512', '--sector-size', '4096', '--pbkdf', 'argon2id', '--pbkdf-memory',
                '65536', '--pbkdf-parallel', '2', '--iter-time', '1000', *flags, str(backing)]
    else:
        args = ['cryptsetup', 'open', '--type', 'luks2', *flags, str(backing), mapper]
    os.lseek(fd, 0, os.SEEK_SET)
    command(args, pass_fds=(fd,), timeout=120)


def mount_pool(p):
    _, _, mount, mapper = paths(p)
    private_dir(mount)
    command(['mount', '-t', 'ext4', '-o', 'nosuid,nodev,noexec,noatime,prjquota', '/dev/mapper/'+mapper, str(mount)])


def inspect_pool(p):
    host_check(p)
    base, backing, mount, mapper = paths(p)
    no_links(backing)
    s = backing.stat()
    need(stat.S_ISREG(s.st_mode) and s.st_size == p['capacityBytes'] and s.st_uid == 0
         and s.st_mode & 0o077 == 0 and s.st_nlink == 1, 'backing_identity_invalid')
    identity = json.loads((base/'identity.json').read_text())
    need(identity['poolId'] == p['poolId'] and identity['backingInode'] == s.st_ino
         and identity['backingDevice'] == s.st_dev, 'backing_identity_changed')
    luks_uuid = command(['cryptsetup', 'luksUUID', str(backing)])
    need(luks_uuid == identity['luksUUID'], 'luks_identity_changed')
    text = command(['cryptsetup', 'status', mapper])
    need(re.search(r'type:\s+LUKS2\b', text) and re.search(r'cipher:\s+aes-xts-plain64\b', text)
         and re.search(r'keysize:\s+512 bits\b', text), 'luks_mapping_invalid')
    loop = re.search(r'^\s*device:\s+(/dev/loop[0-9]+)\s*$', text, re.M)
    need(loop is not None, 'physical_device_rejected')
    need(command(['losetup', '-n', '-O', 'BACK-FILE', loop[1]]) == str(backing), 'loop_backing_changed')
    no_links(mount)
    info = json.loads(command(['findmnt', '-J', '-M', str(mount), '-o', 'SOURCE,FSTYPE,OPTIONS,UUID']))['filesystems'][0]
    need(info['source'] == '/dev/mapper/'+mapper and info['fstype'] == 'ext4'
         and info['uuid'] == identity['filesystemUUID'], 'pool_mount_changed')
    need({'rw', 'nosuid', 'nodev', 'noexec', 'prjquota'} <= set(info['options'].split(',')), 'pool_mount_options_invalid')
    # Kernel quota query must work; feature bits alone are insufficient.
    command(['repquota', '-P', '-n', str(mount)])
    v = os.statvfs(mount)
    return {**identity, 'mountPoint': str(mount), 'mapper': mapper, 'backingPath': str(backing),
            'capacityBytes': s.st_size, 'preallocatedBytes': s.st_blocks*512,
            'availableBytes': v.f_bavail*v.f_frsize, 'filesystemBytes': v.f_blocks*v.f_frsize,
            'mountOptions': info['options'].split(','), 'luks2Verified': True, 'projectQuotaActive': True}


def prepare(p):
    host_check(p)
    base, backing, mount, mapper = paths(p)
    no_links(base)
    no_links(mount)
    need(not base.exists() and not mount.exists() and not Path('/dev/mapper', mapper).exists(), 'pool_already_exists')
    v = os.statvfs('/')
    need(v.f_bavail*v.f_frsize >= p['capacityBytes'], 'host_free_space_insufficient')
    private_dir(base)
    private_dir(mount)
    fd = os.open(backing, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        os.posix_fallocate(stream.fileno(), 0, p['capacityBytes'])
        os.fsync(stream.fileno())
    need(backing.stat().st_blocks*512 >= p['capacityBytes'], 'pool_not_preallocated')
    with local_key(p) as fd:
        crypt(p, 'format', fd)
        crypt(p, 'open', fd)
    return finish_filesystem(p)


def finish_filesystem(p):
    base, backing, mount, mapper = paths(p)
    command(['mkfs.ext4', '-m', '0', '-L', 'TEAM_PHONE_POOL', '-O', 'project,quota',
             '-E', 'quotatype=prjquota,nodiscard,lazy_itable_init=0,lazy_journal_init=0',
             '/dev/mapper/'+mapper], timeout=180)
    s = backing.stat()
    identity = {'schemaVersion': 1, 'poolId': p['poolId'], 'backingInode': s.st_ino, 'backingDevice': s.st_dev,
                'luksUUID': command(['cryptsetup', 'luksUUID', str(backing)]),
                'filesystemUUID': command(['blkid', '-s', 'UUID', '-o', 'value', '/dev/mapper/'+mapper])}
    exclusive_json(base/'identity.json', identity)
    mount_pool(p)
    for name in ('volumes', 'control'):
        private_dir(mount/name)
    exclusive_json(mount/'pool.json', identity)
    command(['sync', '-f', str(mount)])
    return inspect_pool(p)


def finish_empty(p, recovery_path):
    """Only finish the exact, verified blank mapping left by a failed mkfs."""
    host_check(p)
    no_links(recovery_path)
    rs = recovery_path.stat()
    need(rs.st_uid == 0 and rs.st_mode & 0o022 == 0 and rs.st_size < 8192, 'recovery_not_root_owned')
    recovery = json.loads(recovery_path.read_text())
    base, backing, mount, mapper = paths(p)
    no_links(backing)
    s = backing.stat()
    need(recovery['poolId'] == p['poolId'] and recovery['backingPath'] == str(backing)
         and recovery['backingInode'] == s.st_ino and recovery['backingDevice'] == s.st_dev
         and stat.S_ISREG(s.st_mode) and s.st_size == p['capacityBytes'] and s.st_nlink == 1
         and s.st_uid == 0 and s.st_mode & 0o077 == 0, 'recovery_identity_changed')
    need(not (base/'identity.json').exists() and not list(mount.iterdir()), 'recovery_already_initialized')
    need(command(['cryptsetup', 'luksUUID', str(backing)]) == recovery['luksUUID'], 'recovery_luks_changed')
    text = command(['cryptsetup', 'status', mapper])
    loop = re.search(r'^\s*device:\s+(/dev/loop[0-9]+)\s*$', text, re.M)
    need(loop is not None and re.search(r'type:\s+LUKS2\b', text), 'recovery_mapping_invalid')
    need(command(['losetup', '-n', '-O', 'BACK-FILE', loop[1]]) == str(backing), 'recovery_backing_changed')
    need(command(['wipefs', '--no-act', '/dev/mapper/'+mapper]) == '', 'recovery_filesystem_not_blank')
    mounted = subprocess.run(['findmnt', '-n', '-S', '/dev/mapper/'+mapper], capture_output=True, check=False)
    need(mounted.returncode == 1 and not mounted.stdout, 'recovery_device_mounted')
    with local_key(p) as fd:
        command(['cryptsetup', 'open', '--test-passphrase', '--type', 'luks2', '--key-file',
                 f'/proc/self/fd/{fd}', str(backing)], pass_fds=(fd,))
    return finish_filesystem(p)


def close_empty(p):
    info = inspect_pool(p)
    _, _, mount, mapper = paths(p)
    need(not list((mount/'volumes').iterdir()) and not list((mount/'control').iterdir()), 'pool_in_use')
    need(set(x.name for x in mount.iterdir()) <= {'lost+found', 'volumes', 'control', 'pool.json'}, 'pool_not_empty')
    command(['sync', '-f', str(mount)])
    # No force/lazy unmount, no dm removal retry, no loop number guessing.
    command(['umount', str(mount)])
    command(['cryptsetup', 'close', mapper])
    need(not Path('/dev/mapper', mapper).exists(), 'pool_close_unconfirmed')
    need(command(['losetup', '-j', info['backingPath']]) == '', 'pool_loop_not_released')
    return {'poolId': p['poolId'], 'closed': True, 'dataRetained': True}


def reopen(p):
    host_check(p)
    base, backing, mount, mapper = paths(p)
    no_links(backing)
    identity = json.loads((base/'identity.json').read_text())
    s = backing.stat()
    need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_mode & 0o077 == 0 and s.st_nlink == 1
         and s.st_size == p['capacityBytes'] and s.st_ino == identity['backingInode']
         and s.st_dev == identity['backingDevice'] and identity['poolId'] == p['poolId'], 'backing_identity_changed')
    need(not Path('/dev/mapper', mapper).exists(), 'pool_already_open')
    need(command(['cryptsetup', 'luksUUID', str(backing)]) == identity['luksUUID'], 'luks_identity_changed')
    need(not list(mount.iterdir()), 'mount_point_not_empty')
    with local_key(p) as fd:
        crypt(p, 'open', fd)
    mount_pool(p)
    info = inspect_pool(p)
    need(json.loads((mount/'pool.json').read_text()) == identity, 'pool_content_changed')
    return {**info, 'reopened': True, 'dataIdentityRetained': True}


def quota_probe(p):
    inspect_pool(p)
    _, _, mount, _ = paths(p)
    target = mount/'quota-probe'
    need(not target.exists(), 'quota_probe_exists')
    private_dir(target)
    owned = []
    try:
        for project, limit in ((2000000001, 16*GIB), (2000000002, 16*GIB)):
            directory = target/str(project)
            directory.mkdir(mode=0o700)
            owned.append(directory)
            command(['chattr', '-p', str(project), '+P', str(directory)])
            command(['setquota', '-P', str(project), '0', str(limit//1024), '0', '32768', str(mount)])
            os.chown(directory, 10001, 10001)
        # Actually cross the 16 GiB hard limit as the unprivileged runtime UID.
        # fallocate reserves extents, so this doesn't write 16 GiB of payload.
        code = """import errno,os,sys
first,second=[os.open(x,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW) for x in sys.argv[1:]]
os.setgroups([]); os.setgid(10001); os.setuid(10001)
with os.fdopen(os.open('retained',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=second),'wb') as f:
 f.write(b'phone-independent-data'); f.flush(); os.fsync(f.fileno())
with os.fdopen(os.open('overflow',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=first),'wb') as f:
 try: os.posix_fallocate(f.fileno(),0,17*1024**3)
 except OSError as e:
  if e.errno!=errno.EDQUOT: raise
 else: raise RuntimeError('quota_was_not_enforced')
with os.fdopen(os.open('retained',os.O_RDONLY,dir_fd=second),'rb') as f:
 assert f.read()==b'phone-independent-data'
print('quota-enforced-other-data-retained')
"""
        result = command(['python3', '-c', code, *map(str, owned)], timeout=120)
        need(result == 'quota-enforced-other-data-retained', 'quota_probe_failed')
        return {'quotaBytes': 16*GIB, 'runtimeUID': 10001, 'overLimitErrno': 'EDQUOT',
                'otherProjectDataRetained': True, 'projectInheritance': True}
    finally:
        # Only these newly created paths; no recursive cleanup or glob.
        for directory in owned:
            for filename in ('overflow', 'retained'):
                path = directory/filename
                if path.exists():
                    need(path.is_file() and not path.is_symlink(), 'probe_cleanup_identity_invalid')
                    path.unlink()
            directory.rmdir()
            command(['setquota', '-P', directory.name, '0', '0', '0', '0', str(mount)])
        target.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--recovery', type=Path)
    parser.add_argument('action', choices=['prepare', 'inspect', 'close-empty', 'open', 'quota-probe',
        'finish-empty', 'key-create', 'key-inspect', 'header-save'])
    args = parser.parse_args()
    need(os.geteuid() == 0, 'root_maintenance_required')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)
    p = plan_read(args.plan)
    # One local lock per pool; it never stops existing services.
    lock = os.open('/run/lock/teamaibox-phone-pool-'+p['poolId'], os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock, 'w') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX|fcntl.LOCK_NB)
        if args.action in ('key-create', 'key-inspect', 'header-save'):
            result = key_material(p, args.action)
        elif args.action == 'finish-empty':
            need(args.recovery is not None, 'recovery_declaration_required')
            result = finish_empty(p, args.recovery)
        else:
            result = {'prepare': prepare, 'inspect': inspect_pool, 'close-empty': close_empty,
                      'open': reopen, 'quota-probe': quota_probe}[args.action](p)
        if result is not None:
            print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error) if isinstance(error, PoolError) else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
