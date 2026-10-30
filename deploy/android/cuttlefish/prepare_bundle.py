#!/usr/bin/env python3
"""Offline image assembly, never guest startup or copying a lab phone's data."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tarfile
import zipfile

HOST_ROOTS = frozenset(("bin", "etc", "lib64", "usr"))
GUEST_FILES = frozenset(("android-info.txt", "fastboot-info.txt", "boot.img",
    "cuttlefish_example_custom.img", "init_boot.img", "super.img", "userdata.img",
    "vbmeta.img", "vbmeta_system.img", "vbmeta_system_dlkm.img", "vbmeta_vendor_dlkm.img", "vendor_boot.img"))
REQUIRED_GUEST = frozenset(("android-info.txt", "boot.img", "init_boot.img", "super.img", "userdata.img", "vendor_boot.img"))
MAX_EXPANDED = 64 * 1024**3
CDN = "https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024*1024), b""): digest.update(block)
    return digest.hexdigest()


def archive_path(name):
    path = PurePosixPath(name)
    if not path.parts or path.is_absolute() or ".." in path.parts or "\\" in name or "\0" in name:
        raise ValueError("unsafe archive path")
    return path


def extract_host(archive, target):
    with tarfile.open(archive, "r:gz") as stream:
        members, total = [], 0
        for member in stream:
            if member.isdir() and member.name in (".", "./"): continue
            path = archive_path(member.name)
            if path.parts[0] not in HOST_ROOTS: continue
            if member.isdev() or member.isfifo(): raise ValueError("archive contains devices")
            total += member.size
            if total > MAX_EXPANDED: raise ValueError("host archive exceeds build limit")
            members.append(member)
        # Python's data filter also rejects absolute/escaping symbolic and hard links,
        # strips ownership and special mode bits. No shell-expanded tar extraction.
        stream.extractall(target, members=members, filter="data")


def extract_guest(archive, target):
    with zipfile.ZipFile(archive) as stream:
        entries, total, names = [], 0, set()
        for member in stream.infolist():
            path = archive_path(member.filename)
            if len(path.parts) != 1 or member.filename not in GUEST_FILES:
                raise ValueError("unexpected guest archive member")
            if member.filename in names or stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError("duplicate or linked guest member")
            names.add(member.filename); total += member.file_size
            if total > MAX_EXPANDED: raise ValueError("guest archive exceeds build limit")
            entries.append(member)
        if not REQUIRED_GUEST.issubset(names): raise ValueError("guest image incomplete")
        for member in entries:
            destination = target / member.filename
            # Only exact regular guest input files, never an existing runtime dir.
            with stream.open(member) as source, destination.open("xb") as output:
                shutil.copyfileobj(source, output, length=1024*1024)
            destination.chmod(0o644)


def localize_assets(assets, jquery):
    if sha256(jquery) != "ff1523fb7389539c84c65aba19260648793bb4f5e29329d2ee8804bc37a3fe6e":
        raise ValueError("jQuery bytes differ")
    replaced = 0
    for path in sorted(assets.rglob("*.html")):
        original = path.read_text(); replaced += original.count(CDN)
        updated = original.replace(CDN, "jquery-3.6.0.min.js")
        updated = re.sub(r'\s*<link[^>]+href="https://fonts.googleapis.com/[^>]+>', '', updated)
        # Any remaining fetchable external stylesheet/script fails offline assembly.
        if re.search(r'<(?:script|link)\b[^>]*(?:src|href)=[\"\'](?:https?:)?//', updated, re.I):
            raise ValueError("external browser dependency remains")
        if updated != original: path.write_text(updated)
    if replaced < 1: raise ValueError("expected upstream client dependency missing")
    shutil.copyfile(jquery, assets / "jquery-3.6.0.min.js")


def assemble(inputs, target, lock_path):
    lock = json.loads(lock_path.read_text())
    if lock["buildId"] != "16102939" or target.exists(): raise ValueError("new fixed-build output required")
    for name, expected in lock["inputs"].items():
        if len(archive_path(name).parts) != 1 or sha256(inputs / name) != expected:
            raise ValueError("immutable build input mismatch")
    target.mkdir(parents=True)
    extract_host(inputs / "cvd-host_package.tar.gz", target)
    extract_guest(inputs / "aosp_cf_arm64_only_phone-img-16102939.zip", target)
    localize_assets(target / "usr/share/webrtc/assets", inputs / "jquery-3.6.0.min.js")
    # Upstream demonstration private keys are public sample material, not product
    # identity. Deployment must provide fresh runtime-scoped certificates later.
    certificates = target / "usr/share/webrtc/certs"
    if certificates.exists(): shutil.rmtree(certificates)
    (target / "teamaibox-inputs.json").write_text(json.dumps(lock, indent=2)+"\n")
    # A public base bundle is shared read-only. Private guest writes go elsewhere.
    for root, directories, files in os.walk(target, followlinks=False):
        for name in directories + files:
            path = Path(root) / name
            if not path.is_symlink(): path.chmod(path.stat().st_mode & ~0o222)
    target.chmod(0o555)
    print(json.dumps({"buildId":lock["buildId"], "offlineAssets":True,
        "sampleCertificatesRemoved":True, "privateGuestDataImported":False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--lock", type=Path, required=True)
    args = parser.parse_args()
    assemble(args.inputs, args.output, args.lock)
