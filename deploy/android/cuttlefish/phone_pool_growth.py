#!/usr/bin/env python3
"""Grow an existing encrypted phone pool, never create, format or shrink one.

The original pool helper remains immutable. A root-owned capacity declaration
permits an interrupted grow to reopen at either its old or approved new size.
Keys remain in the same appliance's mounted encrypted key store.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import stat
import sys

GIB = 1024**3
BASE = Path(__file__).with_name('phone_file_pool.py')
spec = importlib.util.spec_from_file_location('original_phone_file_pool', BASE)
original = importlib.util.module_from_spec(spec)
spec.loader.exec_module(original)
need, command = original.need, original.command


def validate_capacity(old, target):
    need(type(old) is int and type(target) is int and 64*GIB <= old <= target <= 16*1024*GIB
         and old % (16*GIB) == target % (16*GIB) == 0, 'capacity_invalid_or_shrink')


def plan_read(path):
    original.no_links(path)
    s = path.stat()
    need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_mode & 0o022 == 0
         and s.st_nlink == 1 and s.st_size < 8192, 'capacity_plan_untrusted')
    c = json.loads(path.read_bytes())
    need(set(c) == {'version', 'basePlan', 'basePlanSha256', 'minimumCapacityBytes', 'capacityBytes'}
         and c['version'] == 1, 'capacity_plan_invalid')
    source = Path(c['basePlan'])
    p = original.plan_read(source)
    need(hashlib.sha256(source.read_bytes()).hexdigest() == c['basePlanSha256'], 'original_plan_changed')
    validate_capacity(c['minimumCapacityBytes'], c['capacityBytes'])
    p = dict(p, capacityBytes=c['capacityBytes'], minimumCapacityBytes=c['minimumCapacityBytes'])
    return p


def actual_plan(p):
    backing = original.paths(p)[1]
    original.no_links(backing)
    size = backing.stat().st_size
    need(p['minimumCapacityBytes'] <= size <= p['capacityBytes'], 'backing_size_outside_growth')
    # inode, device, LUKS and filesystem checks still run in the original helper.
    return dict(p, capacityBytes=size)


def inspect_pool(p):
    return original.inspect_pool(actual_plan(p))


def reopen(p):
    return original.reopen(actual_plan(p))


def grow_mapping(backing, mapper, loop, target, key_fd):
    """Only called after full pool verification (or an isolated synthetic test)."""
    need(re.fullmatch('/dev/loop[0-9]+', loop), 'physical_device_rejected')
    need(command(['losetup', '-n', '-O', 'BACK-FILE', loop]) == str(backing), 'loop_backing_changed')
    fd = os.open(backing, os.O_RDWR | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_size <= target, 'shrink_rejected')
        if st.st_size < target:
            os.posix_fallocate(fd, st.st_size, target-st.st_size)
        os.fsync(fd)
        # Existing pools can be sparse (or have reclaimed extents). fallocate
        # guarantees the new range; requiring every OLD byte to be allocated
        # rejects a safe online grow after the file has already been extended.
        need(os.fstat(fd).st_size == target, 'allocation_incomplete')
        command(['losetup', '--set-capacity', loop])
        os.lseek(key_fd, 0, os.SEEK_SET)
        command(['cryptsetup', 'resize', mapper, '--key-file', f'/proc/self/fd/{key_fd}'],
                pass_fds=(key_fd,), timeout=120)
        # No force, unmount, partition editing, shrink or discard options.
        command(['resize2fs', '/dev/mapper/'+mapper], timeout=300)
    finally:
        os.close(fd)


def grow(p):
    before = inspect_pool(p)
    base, backing, mount, mapper = original.paths(p)
    target = p['capacityBytes']
    free = os.statvfs(base)
    need(free.f_bavail*free.f_frsize >= target-before['capacityBytes']+64*GIB,
         'host_space_insufficient_for_growth')
    status = command(['cryptsetup', 'status', mapper])
    loop = re.search(r'^\s*device:\s+(/dev/loop[0-9]+)\s*$', status, re.M)
    need(loop is not None, 'physical_device_rejected')
    with original.local_key(p) as key:
        # Reject a wrong local key before allocating or resizing anything.
        command(['cryptsetup', 'open', '--test-passphrase', '--type', 'luks2',
                 '--key-file', f'/proc/self/fd/{key}', str(backing)], pass_fds=(key,))
        grow_mapping(backing, mapper, loop[1], target, key)
    after = inspect_pool(p)
    need(all(before[k] == after[k] for k in ('poolId', 'backingInode', 'backingDevice',
                                          'luksUUID', 'filesystemUUID')), 'pool_identity_changed')
    need(after['capacityBytes'] == target and after['filesystemBytes'] > target*0.95,
         'filesystem_growth_incomplete')
    return dict(before=before, after=after, online=True, formatted=False, dataDeleted=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('action', choices=('inspect', 'grow', 'open', 'key-inspect'))
    a = parser.parse_args()
    need(os.geteuid() == 0, 'root_required')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0)); os.umask(0o077)
    p = plan_read(a.plan)
    fd = os.open('/run/lock/teamaibox-phone-pool-'+p['poolId'], os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
        if a.action == 'key-inspect':
            result = original.key_material(p, a.action)
        else:
            result = {'inspect': inspect_pool, 'grow': grow, 'open': reopen}[a.action](p)
        if result is not None: print(json.dumps(result, sort_keys=True))
    finally: os.close(fd)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'error': str(error) if isinstance(error, original.PoolError) else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
