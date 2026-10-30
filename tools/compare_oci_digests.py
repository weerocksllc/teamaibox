#!/usr/bin/env python3
"""Compare deterministic Linux ARM64 OCI archives by verified manifest digest."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import tarfile
from typing import Any, Mapping, Sequence


DIGEST = re.compile(r"^sha256:([a-f0-9]{64})$")


class OciArchiveError(ValueError):
    pass


def _json_member(archive: tarfile.TarFile, name: str) -> Mapping[str, Any]:
    try:
        member = archive.getmember(name)
    except KeyError as error:
        raise OciArchiveError("OCI archive is missing " + name) from error
    if not member.isfile() or member.issym() or member.islnk():
        raise OciArchiveError("OCI member is not a regular file: " + name)
    stream = archive.extractfile(member)
    if stream is None:
        raise OciArchiveError("OCI member cannot be read: " + name)
    value = json.loads(stream.read())
    if not isinstance(value, Mapping):
        raise OciArchiveError("OCI JSON member is not an object: " + name)
    return value


def _blob(archive: tarfile.TarFile, digest: str) -> bytes:
    match = DIGEST.fullmatch(digest)
    if not match:
        raise OciArchiveError("OCI descriptor digest is invalid")
    name = "blobs/sha256/" + match.group(1)
    try:
        member = archive.getmember(name)
    except KeyError as error:
        raise OciArchiveError("OCI descriptor blob is missing") from error
    if not member.isfile() or member.issym() or member.islnk():
        raise OciArchiveError("OCI blob is not a regular file")
    stream = archive.extractfile(member)
    if stream is None:
        raise OciArchiveError("OCI blob cannot be read")
    content = stream.read()
    if hashlib.sha256(content).hexdigest() != match.group(1):
        raise OciArchiveError("OCI blob digest does not match its descriptor")
    return content


def inspect_archive(filename: pathlib.Path) -> dict[str, str]:
    if not filename.is_file() or filename.is_symlink():
        raise OciArchiveError("OCI archive must be a regular file")
    with tarfile.open(filename, mode="r:*") as archive:
        layout = _json_member(archive, "oci-layout")
        if layout.get("imageLayoutVersion") != "1.0.0":
            raise OciArchiveError("OCI layout version must be 1.0.0")
        index = _json_member(archive, "index.json")
        manifests = index.get("manifests")
        if index.get("schemaVersion") != 2 or not isinstance(manifests, list) or len(manifests) != 1:
            raise OciArchiveError("OCI archive must contain one image manifest")
        descriptor = manifests[0]
        if not isinstance(descriptor, Mapping):
            raise OciArchiveError("OCI manifest descriptor is invalid")
        manifest_digest = str(descriptor.get("digest", ""))
        manifest = json.loads(_blob(archive, manifest_digest))
        if not isinstance(manifest, Mapping) or manifest.get("schemaVersion") != 2:
            raise OciArchiveError("OCI image manifest is invalid")
        config_descriptor = manifest.get("config")
        if not isinstance(config_descriptor, Mapping):
            raise OciArchiveError("OCI image config descriptor is invalid")
        config = json.loads(_blob(archive, str(config_descriptor.get("digest", ""))))
        if not isinstance(config, Mapping):
            raise OciArchiveError("OCI image config is invalid")
        if config.get("architecture") != "arm64" or config.get("os") != "linux":
            raise OciArchiveError("OCI image must target Linux ARM64")
        runtime = config.get("config")
        if not isinstance(runtime, Mapping):
            raise OciArchiveError("OCI runtime config is missing")
        user = str(runtime.get("User", ""))
        if not user or user in {"0", "0:0", "root", "root:root"}:
            raise OciArchiveError("OCI runtime user must be non-root")
        return {
            "manifestDigest": manifest_digest,
            "architecture": "arm64",
            "os": "linux",
            "user": user,
        }


def compare(first: pathlib.Path, second: pathlib.Path) -> dict[str, str]:
    left = inspect_archive(first)
    right = inspect_archive(second)
    if left["manifestDigest"] != right["manifestDigest"]:
        raise OciArchiveError(
            "reproducibility failure: manifest digests differ "
            + left["manifestDigest"]
            + " != "
            + right["manifestDigest"]
        )
    return left


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("first", type=pathlib.Path)
    parser.add_argument("second", type=pathlib.Path)
    args = parser.parse_args(argv)
    try:
        result = compare(args.first, args.second)
    except OciArchiveError as error:
        parser.error(str(error))
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
