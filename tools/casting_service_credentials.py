#!/usr/bin/env python3
"""Restore service identities from an already unlocked LUKS2 volume to tmpfs.

This adapter never unlocks/formats/mounts anything, starts Docker, handles a
casting session, or accepts arbitrary archive members. It copies only the
three fixed service configurations and their long-lived TLS/SFU identities.
Session PINs, viewer tokens, receiver keys and media are not in this bundle.
The installer supplies a root-owned plan with an exact encrypted-volume
identity. Failure leaves the prior generation untouched and emits no secrets.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

GENERATION = re.compile(r"casting-service-20[0-9]{6}-a[1-9][0-9]{0,3}")
DESTINATION = Path("/run/teamaibox/casting")
FILES = {
    "media": (65532, ("runtime.json", "sfu-gateway.json", "ca.crt",
        "media-server.crt", "media-server.key", "media-client.crt", "media-client.key",
        "sfu-server.crt", "sfu-server.key", "sfu-client.crt", "sfu-client.key", "sfu-api-key", "sfu-api-secret")),
    "platform": (1000, ("callback-contract.json", "runtime-identity.json", "platform.env.json", "ca.crt",
        "platform-server.crt", "platform-server.key", "platform-client.crt", "platform-client.key")),
    "sfu": (65532, ("sfu.yaml",)),
}
MAX_FILE = 65536
MAX_BUNDLE = 1024 * 1024


class CredentialError(ValueError):
    def __init__(self): super().__init__("casting_service_credentials_unavailable")


def require(condition):
    if not condition: raise CredentialError()


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys))
    return value


def unique(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value)
        value[key] = item
    return value


def digest(raw): return "sha256:" + hashlib.sha256(raw).hexdigest()


def secure_directory(path, *, uid=0, private=True):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid)
    require(not info.st_mode & (0o077 if private else 0o022))
    return path


def read_private(path, *, uid=0):
    """Read a bounded, non-link descriptor, never a FIFO/device or argv secret."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    data = bytearray()
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == uid
                and not before.st_mode & 0o077 and 1 <= before.st_size <= MAX_FILE)
        while len(data) <= MAX_FILE:
            block = os.read(descriptor, min(4096, MAX_FILE + 1 - len(data)))
            if not block: break
            data.extend(block)
        after = os.fstat(descriptor)
        require(len(data) == before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns)
        return data
    except Exception:
        data[:] = b"\0" * len(data)
        raise
    finally: os.close(descriptor)


def command(args):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=10, env={"PATH":"/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL":"C"})
    require(result.returncode == 0 and len(result.stdout) <= MAX_FILE)
    return result.stdout.decode().strip()


def validate_plan(plan):
    exact(plan, ("schemaVersion", "generation", "source", "destination", "encryptedVolume"))
    require(plan["schemaVersion"] == 1 and GENERATION.fullmatch(plan["generation"]))
    volume = exact(plan["encryptedVolume"], ("mount", "mapper", "filesystemUuid", "luksUuid"))
    for name in ("filesystemUuid", "luksUuid"):
        require(type(volume[name]) is str and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", volume[name]))
    require(type(volume["mapper"]) is str and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{1,79}", volume["mapper"]))
    mount = Path(volume["mount"])
    require(mount.is_absolute() and len(mount.parts) >= 4 and ".." not in mount.parts)
    require(plan["source"] == str(mount / "service-identities" / plan["generation"]))
    require(plan["destination"] == str(DESTINATION / plan["generation"]))
    return plan


def require_encrypted_source(plan):
    """Read-only exact mapper/filesystem checks; no fallback to an ordinary disk."""
    volume = plan["encryptedVolume"]
    source = Path(plan["source"])
    secure_directory(Path(volume["mount"]), private=False)
    for path in (source.parent, source): secure_directory(path)
    listing = json.loads(command(["findmnt", "-J", "-T", str(source), "-o", "SOURCE,TARGET,FSTYPE,UUID,OPTIONS"]))
    require(len(listing["filesystems"]) == 1)
    actual = listing["filesystems"][0]
    mapper = "/dev/mapper/" + volume["mapper"]
    require(actual["source"] == mapper and actual["target"] == volume["mount"]
            and actual["fstype"] == "ext4" and actual["uuid"] == volume["filesystemUuid"]
            and {"nodev", "nosuid"} <= set(actual["options"].split(",")))
    status = command(["cryptsetup", "status", volume["mapper"]])
    fields = {line.split(":",1)[0].strip():line.split(":",1)[1].strip()
              for line in status.splitlines()[1:] if ":" in line}
    require(fields.get("type") == "LUKS2")
    device = fields.get("device", "")
    require(re.fullmatch(r"/dev/(?:loop[0-9]+|nvme[0-9]+n[0-9]+(?:p[0-9]+)?|sd[a-z]+[0-9]*)", device))
    require(command(["cryptsetup", "luksUUID", device]) == volume["luksUuid"])


def require_tmpfs(path):
    path = Path(path)
    matches = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        before, after = line.split(" - ", 1)
        mount = Path(before.split()[4])
        if mount == path or mount in path.parents: matches.append((len(mount.parts), after.split()[0]))
    require(matches and max(matches)[1] == "tmpfs")


def load_bundle(source, generation, *, owner=0):
    buffers = {}
    try:
        raw = read_private(source / "bundle.json", uid=owner)
        try: manifest = json.loads(raw, object_pairs_hook=unique)
        finally: raw[:] = b"\0" * len(raw)
        exact(manifest, ("schemaVersion", "generation", "files"))
        require(manifest["schemaVersion"] == 1 and manifest["generation"] == generation)
        expected = {f"{section}/{name}" for section, (_, names) in FILES.items() for name in names}
        exact(manifest["files"], expected)
        require({p.name for p in source.iterdir()} == {"bundle.json", *FILES})
        for section, (_, names) in FILES.items():
            secure_directory(source / section, uid=owner)
            require({p.name for p in (source / section).iterdir()} == set(names))
            for name in names:
                key = f"{section}/{name}"
                buffers[key] = read_private(source / key, uid=owner)
                require(manifest["files"][key] == digest(buffers[key]))
                require(sum(map(len, buffers.values())) <= MAX_BUNDLE)
        return buffers
    except Exception:
        for data in buffers.values(): data[:] = b"\0" * len(data)
        raise


def restore(plan, *, source_check=require_encrypted_source, tmpfs_check=require_tmpfs,
            owner=0, destinations=None):
    """Idempotent same-byte recovery, never replace a live credential generation."""
    validate_plan(plan)
    require(os.geteuid() == owner)
    source_check(plan)  # Verify encryption before reading even the file list.
    source, destination = Path(plan["source"]), Path(plan["destination"])
    tmpfs_check(destination.parent)
    secure_directory(destination.parent, uid=owner, private=False)
    uids = {name: uid for name,(uid,_) in FILES.items()} if destinations is None else destinations
    require(set(uids) == set(FILES) and all(type(uid) is int and uid > 0 for uid in uids.values()))
    buffers, temporary, created = {}, None, []
    try:
        buffers = load_bundle(source, plan["generation"], owner=owner)
        if destination.exists() or destination.is_symlink():
            secure_directory(destination, uid=owner, private=False)
            require(stat.S_IMODE(destination.stat().st_mode) == 0o711
                    and {p.name for p in destination.iterdir()} == set(FILES))
            for section, (_, names) in FILES.items():
                secure_directory(destination / section, uid=uids[section])
                require(stat.S_IMODE((destination / section).stat().st_mode) == 0o500
                        and {p.name for p in (destination / section).iterdir()} == set(names))
                for name in names:
                    path = destination / section / name
                    actual = read_private(path, uid=uids[section])
                    try: require(actual == buffers[f"{section}/{name}"] and stat.S_IMODE(path.stat().st_mode) == 0o400)
                    finally: actual[:] = b"\0" * len(actual)
            return {"status":"passed", "generation":plan["generation"], "alreadyPresent":True,
                    "sessionRestored":False, "serviceStarted":False}
        temporary = Path(tempfile.mkdtemp(prefix=".prepare-", dir=destination.parent))
        for section, (_, names) in FILES.items():
            folder = temporary / section
            folder.mkdir(mode=0o700)
            created.append(folder)
            for name in names:
                path = folder / name
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
                created.append(path)
                try:
                    data = buffers[f"{section}/{name}"]
                    offset = 0
                    while offset < len(data): offset += os.write(descriptor, memoryview(data)[offset:])
                    os.fchmod(descriptor, 0o400)
                    os.fchown(descriptor, uids[section], uids[section])
                finally: os.close(descriptor)
            os.chown(folder, uids[section], uids[section]); folder.chmod(0o500)
        temporary.chmod(0o711)
        # Parent is root-owned and unwritable by service users. The installer
        # serializes generations with systemd; never replace an existing one.
        require(not destination.exists() and not destination.is_symlink())
        os.rename(temporary, destination)
        temporary = None
        return {"status":"passed", "generation":plan["generation"], "alreadyPresent":False,
                "sessionRestored":False, "serviceStarted":False}
    finally:
        for data in buffers.values(): data[:] = b"\0" * len(data)
        if temporary is not None:
            for path in created:
                if path.is_dir(): path.chmod(0o700)
            for path in reversed(created):
                if path.is_dir(): path.rmdir()
                else: path.unlink()
            temporary.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True)
    args = parser.parse_args()
    try:
        path = Path(args.plan)
        require(path.is_absolute() and path.resolve(strict=True) == path)
        secure_directory(path.parent)
        raw = read_private(path)
        try: plan = json.loads(raw, object_pairs_hook=unique)
        finally: raw[:] = b"\0" * len(raw)
        result = restore(plan)
        print(json.dumps(result))
        return 0
    except Exception:
        print(json.dumps({"status":"failed", "failure":"casting_service_credentials_unavailable",
                          "sessionRestored":False, "serviceStarted":False}))
        return 1


if __name__ == "__main__": sys.exit(main())
