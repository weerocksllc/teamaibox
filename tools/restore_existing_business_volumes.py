#!/usr/bin/env python3
"""Restore explicitly installed LUKS2 volumes; never format, move or rekey data."""
import argparse
import json
import os
import re
from pathlib import Path
import stat
import subprocess
import sys

DEFAULT_CONFIGURATION = '/etc/teamaibox/storage-volumes.json'


def volume_paths(volume):
    # Legacy fields are understood only when explicitly imported into this
    # machine's configuration, never supplied as source-code defaults.
    root = volume.get('root')
    return (Path(volume.get('source', str(Path(root) / 'volume.img') if root else '')),
            Path(volume.get('keyFile', str(Path(root) / 'automatic.key') if root else '')),
            Path(volume.get('mountPoint', str(Path(root) / 'mount') if root else '')))


def validate_volumes(value):
    need(value.get('version') == 1 and isinstance(value.get('volumes'), list), 'volume_configuration_invalid')
    seen = set()
    for v in value['volumes']:
        source, key, mount = volume_paths(v)
        need(all(p.is_absolute() and '..' not in p.parts and str(p) != '/' for p in (source, key, mount)), 'volume_path_invalid')
        need(v.get('kind', 'file') in ('file', 'block') and v.get('bootPolicy', 'automatic-slot-0') == 'automatic-slot-0', 'volume_policy_unsupported')
        need(type(v.get('directIO', False)) is bool and (not v.get('directIO') or v.get('kind', 'file') == 'file'), 'volume_direct_io_policy_invalid')
        need(bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,126}', v['mapper'])), 'mapper_name_invalid')
        for field in ('luksUuid', 'fsUuid'):
            need(bool(re.fullmatch(r'[a-f0-9-]{36}', v[field])), 'volume_uuid_invalid')
        need(type(v['minimumSize']) is int and v['minimumSize'] > 0, 'minimum_size_invalid')
        need({'nodev', 'nosuid'} <= set(v['mountOptions'].split(',')) <= {'nodev', 'nosuid', 'noexec', 'rw', 'prjquota'}, 'mount_options_invalid')
        for identity in (str(source), str(mount), v['mapper'], v['luksUuid'], v['fsUuid']):
            need(identity not in seen, 'duplicate_volume_identity'); seen.add(identity)
    return value['volumes']


def load_volumes(path):
    secure_path(path)
    return validate_volumes(json.loads(Path(path).read_text()))


def need(condition, code):
    if not condition:
        raise RuntimeError(code)


def run(args, allowed=(0,)):
    p = subprocess.run(args, capture_output=True, text=True, timeout=120,
                       env={**os.environ, "LC_ALL": "C"})
    need(p.returncode in allowed, "bounded_" + args[0] + "_failed")
    return p.stdout.strip()


def secure_path(path, *, directory=False, private=False):
    path = Path(path)
    need(path.resolve() == path, "symlink_path_rejected")
    s = path.lstat()
    need(s.st_uid == 0 and not s.st_mode & 0o022, "unsafe_path_owner_or_mode")
    need(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode),
         "unexpected_path_type")
    if private:
        need(not s.st_mode & 0o077, "factor_permissions_not_private")
    return s


def mounted(path):
    raw = run(["findmnt", "-J", "-M", str(path), "-o", "SOURCE,TARGET,FSTYPE,UUID,OPTIONS"], (0, 1))
    return json.loads(raw)["filesystems"][0] if raw else None


def verify_mount(volume, actual):
    need(actual is not None and actual["target"] == str(volume_paths(volume)[2])
         and actual["source"] == "/dev/mapper/" + volume["mapper"]
         and actual["fstype"] == "ext4" and actual["uuid"] == volume["fsUuid"],
         "mounted_volume_identity_mismatch")
    need({"rw", *volume["mountOptions"].split(",")} <= set(actual["options"].split(",")),
         "mount_security_options_mismatch")


def verify_mapper(volume, configure=False):
    status = run(["cryptsetup", "status", volume["mapper"]])
    device = next((line.split(":", 1)[1].strip() for line in status.splitlines()
                   if line.strip().startswith("device:")), "")
    if volume.get('kind', 'file') == 'file':
        need(device.startswith("/dev/loop") and device[9:].isdigit(), "mapper_not_file_backed")
        loop = json.loads(run(["losetup", "-J", "--list", "--output", "NAME,BACK-FILE", device]))
        need(len(loop["loopdevices"]) == 1 and loop["loopdevices"][0]["back-file"] == str(volume_paths(volume)[0]), "mapper_backing_file_mismatch")
        if volume.get('directIO'):
            # File-backed encrypted storage otherwise caches both decrypted
            # pages and the backing image. Cold model offload can charge both
            # to one container and OOM despite ample host memory. Use direct
            # backing I/O, without dropping any host cache or changing limits.
            if configure:
                run(['losetup', '--direct-io=on', device])
            direct = json.loads(run(['losetup', '-J', '--list', '--output', 'NAME,BACK-FILE,DIO', device]))['loopdevices']
            need(len(direct) == 1 and direct[0]['back-file'] == str(volume_paths(volume)[0])
                 and direct[0].get('dio') == 1, 'volume_direct_io_not_enabled')
    else:
        need(Path(device).resolve() == volume_paths(volume)[0].resolve(), 'mapper_block_device_mismatch')
    need(run(["blkid", "-s", "UUID", "-o", "value", "/dev/mapper/" + volume["mapper"]])
         == volume["fsUuid"], "filesystem_uuid_mismatch")


def verify_policy(mount):
    policy = Path(mount) / "encryption_transition_policy/boot-policy.json"
    if policy.exists() or policy.is_symlink():
        # Current installation has no policy. A future mode transition needs
        # its own approved boot adapter, never an implicit automatic fallback.
        raise RuntimeError("unlock_policy_changed_requires_review")


def verify_image_size(volume, size):
    # Capacity is not identity: online growth preserves LUKS/filesystem UUIDs.
    # Reject a truncated or non-sector-aligned image, not legitimate expansion.
    need(type(size) is int and size >= volume["minimumSize"] and size % 512 == 0,
         "volume_size_invalid")


def restore(volume, check_only=False):
    source, key, mount = volume_paths(volume)
    if volume.get('kind', 'file') == 'file':
        secure_path(source.parent, directory=True, private=True)
        image_size = secure_path(source).st_size
    else:
        info = source.resolve().stat()
        need(stat.S_ISBLK(info.st_mode) and info.st_uid == 0, 'block_device_required')
        image_size = int(run(['blockdev', '--getsize64', str(source)]))
    verify_image_size(volume, image_size)
    factor = secure_path(key, private=True)
    need(factor.st_size == 64, "automatic_factor_shape_mismatch")
    actual = mounted(mount)
    if actual is None:
        secure_path(mount, directory=True)
    else:
        # The spare filesystem root is owned by the existing object-service
        # UID 10001. Do not chown user data: verify the mount identity instead.
        need(mount.resolve() == mount, "symlink_mount_rejected")
        verify_mount(volume, actual)
    need(run(["cryptsetup", "luksUUID", str(source)]) == volume["luksUuid"],
         "luks_uuid_mismatch")
    run(["cryptsetup", "isLuks", "--type", "luks2", str(source)])
    # Never read a factor into Python, put it in argv, copy it, or use recovery.
    run(["cryptsetup", "open", "--test-passphrase", "--type", "luks2", "--key-slot", "0",
         "--key-file", str(key), str(source)])
    mapper = Path("/dev/mapper") / volume["mapper"]
    opened_here = mounted_here = False
    if check_only:
        need(mapper.exists() and actual is not None, "business_volume_not_restored")
    try:
        if not mapper.exists():
            need(actual is None, "foreign_mount_blocks_unlock")
            run(["cryptsetup", "open", "--type", "luks2", "--key-slot", "0", "--key-file",
                 str(key), str(source), volume["mapper"]])
            opened_here = True
        verify_mapper(volume, configure=not check_only)
        if actual is None:
            need(not any(mount.iterdir()), "nonempty_unmounted_directory_rejected")
            run(["mount", "-t", "ext4", "-o", volume["mountOptions"], str(mapper), str(mount)])
            mounted_here = True
        verify_mount(volume, mounted(mount))
        verify_policy(mount)
    except Exception:
        if mounted_here:
            run(["umount", str(mount)])
        if opened_here:
            run(["cryptsetup", "close", volume["mapper"]])
        raise
    return {"mapper": volume["mapper"], "luksUuid": volume["luksUuid"],
            "filesystemUuid": volume["fsUuid"], "imageSizeBytes": image_size, "mounted": True,
            "openedHere": opened_here, "mountedHere": mounted_here}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--check", action="store_true")
    p.add_argument('--configuration', default=DEFAULT_CONFIGURATION)
    args = p.parse_args()
    need(os.geteuid() == 0, "root_required")
    values = [restore(v, args.check) for v in load_volumes(args.configuration)]
    print(json.dumps({"status": "passed", "volumes": values, "factorChanged": False,
                      "physicalDiskTouched": False, "formatted": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # No raw subprocess output, filesystem payload, or credential in logs.
        print(json.dumps({"status": "failed", "failure": str(error) if isinstance(error, RuntimeError)
                          else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
