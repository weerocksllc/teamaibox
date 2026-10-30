#!/usr/bin/env python3
"""One-shot local file-backed Windows lab storage.

The root-owned plan identifies this appliance and its already mounted encrypted
key store. No remote key export, SSH custody, or physical disk formatting exists.
Only the explicit lab file is managed; existing guests are never discovered
and replaced automatically.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import resource

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'android'/'cuttlefish'))
from phone_file_pool import command, need, no_links, private_dir, exclusive_json, local_key, key_material, host_check, plan_read as pool_plan_read

def paths(lab):
    need(re.fullmatch(r'windows-arm64-storage-\d{8}-a[1-9]\d*', lab), 'invalid_lab_id')
    base = Path('/var/lib/teamaibox/windows-lab') / lab
    return base, base/'storage.luks2', Path('/srv/teamaibox/windows-lab')/lab, 'tab-' + lab


def plan_read(path):
    plan = pool_plan_read(path)
    _, _, target, _ = paths(plan['labId'])
    key_root = Path(plan['keyStore']['encryptedRoot'])
    need(key_root != target and target not in key_root.parents, 'key_store_unlock_cycle')
    return plan


def mount(lab):
    _, _, target, mapper = paths(lab)
    private_dir(target)
    command(['mount', '-t', 'ext4', '-o', 'nosuid,nodev,noexec,noatime', '/dev/mapper/'+mapper, str(target)])


def inspect(p):
    host_check(p)
    lab = p['labId']
    base, backing, target, mapper = paths(lab)
    no_links(backing)
    s = backing.stat()
    identity = json.loads((base/'identity.json').read_text())
    need(backing.is_file() and s.st_uid == 0 and s.st_nlink == 1 and s.st_mode & 0o077 == 0
         and s.st_size == p['capacityBytes'] and s.st_ino == identity['inode'] and s.st_dev == identity['device'],
         'backing_identity_changed')
    need(command(['cryptsetup', 'luksUUID', str(backing)]) == identity['luksUUID'], 'luks_identity_changed')
    state = command(['cryptsetup', 'status', mapper])
    loop = re.search(r'^\s*device:\s+(/dev/loop\d+)\s*$', state, re.M)
    need(loop and re.search(r'type:\s+LUKS2\b', state)
         and re.search(r'cipher:\s+aes-xts-plain64\b', state), 'mapping_invalid')
    need(command(['losetup', '-n', '-O', 'BACK-FILE', loop[1]]) == str(backing), 'backing_changed')
    entry = json.loads(command(['findmnt', '-J', '-M', str(target), '-o', 'SOURCE,UUID,OPTIONS']))['filesystems'][0]
    need(entry['source'] == '/dev/mapper/'+mapper and entry['uuid'] == identity['filesystemUUID']
         and {'rw', 'nosuid', 'nodev', 'noexec'} <= set(entry['options'].split(',')), 'mount_identity_changed')
    v = os.statvfs(target)
    return {**identity, 'mountPoint': str(target), 'backingPath': str(backing), 'mapper': mapper,
            'logicalBytes': s.st_size, 'allocatedBytes': s.st_blocks*512,
            'availableBytes': v.f_bavail*v.f_frsize, 'luks2Verified': True}


def operate(p, action):
    host_check(p)
    lab = p['labId']
    base, backing, target, mapper = paths(lab)
    if action == 'prepare':
        no_links(base)
        no_links(target)
        need(not base.exists() and not target.exists() and not Path('/dev/mapper', mapper).exists(), 'lab_exists')
        v = os.statvfs('/')
        need(v.f_bavail*v.f_frsize >= p['capacityBytes'], 'insufficient_lab_storage')
        private_dir(base)
        fd = os.open(backing, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            os.posix_fallocate(stream.fileno(), 0, p['capacityBytes'])
            stream.flush()
            os.fsync(stream.fileno())
        with local_key(p) as key:
            flags = ['--key-file', '/proc/self/fd/'+str(key)]
            command(['cryptsetup', 'luksFormat', '--type', 'luks2', '--batch-mode', '--cipher',
                     'aes-xts-plain64', '--key-size', '512', '--sector-size', '4096', '--pbkdf', 'argon2id',
                     '--pbkdf-memory', '65536', '--pbkdf-parallel', '2', '--iter-time', '1000', *flags, str(backing)],
                    pass_fds=(key,), timeout=120)
            os.lseek(key, 0, os.SEEK_SET)
            command(['cryptsetup', 'open', '--type', 'luks2', *flags, str(backing), mapper], pass_fds=(key,))
        command(['mkfs.ext4', '-m', '0', '-L', 'TAB_WINDOWS_LAB', '-E',
                 'nodiscard,lazy_itable_init=0,lazy_journal_init=0', '/dev/mapper/'+mapper], timeout=180)
        s = backing.stat()
        identity = {'labId': lab, 'inode': s.st_ino, 'device': s.st_dev,
                    'luksUUID': command(['cryptsetup', 'luksUUID', str(backing)]),
                    'filesystemUUID': command(['blkid', '-s', 'UUID', '-o', 'value', '/dev/mapper/'+mapper])}
        exclusive_json(base/'identity.json', identity)
        mount(lab)
        private_dir(target/'guest')
        exclusive_json(target/'storage.json', identity)
    elif action == 'open':
        no_links(backing)
        identity = json.loads((base/'identity.json').read_text())
        need(backing.stat().st_ino == identity['inode'] and backing.stat().st_dev == identity['device']
             and command(['cryptsetup', 'luksUUID', str(backing)]) == identity['luksUUID'], 'backing_changed')
        need(not Path('/dev/mapper', mapper).exists(), 'mapping_already_open')
        with local_key(p) as key:
            command(['cryptsetup', 'open', '--type', 'luks2', '--key-file', '/proc/self/fd/'+str(key),
                     str(backing), mapper], pass_fds=(key,))
        mount(lab)
    elif action == 'close-empty':
        inspect(p)
        need(not list((target/'guest').iterdir()), 'guest_data_exists')
        command(['umount', str(target)])
        command(['cryptsetup', 'close', mapper])
        return {'closed': True, 'guestEmpty': True}
    return inspect(p)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('action', choices=('key-create', 'key-inspect', 'prepare', 'inspect', 'open', 'close-empty'))
    args = parser.parse_args()
    try:
        need(os.geteuid() == 0, 'root_maintenance_required')
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0)); os.umask(0o077)
        plan = plan_read(args.plan)
        result = key_material(plan, args.action) if args.action.startswith('key-') else operate(plan, args.action)
        if result is not None:
            print(json.dumps(result))
    except Exception as exc:
        print(str(exc)[:180], file=sys.stderr)
        sys.exit(1)
