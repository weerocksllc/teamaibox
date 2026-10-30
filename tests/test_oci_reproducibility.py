from __future__ import annotations

import hashlib
import io
import json
import pathlib
import tarfile
import tempfile
import unittest

from tools.compare_oci_digests import OciArchiveError, compare, inspect_archive


def _digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _write_archive(filename: pathlib.Path, *, architecture: str = "arm64", user: str = "1000:1000", marker: str = "same") -> None:
    config = json.dumps(
        {"architecture": architecture, "os": "linux", "config": {"User": user, "Labels": {"marker": marker}}},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    config_digest = _digest(config)
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": config_digest, "size": len(config)},
            "layers": [],
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    manifest_digest = _digest(manifest)
    index = json.dumps(
        {
            "schemaVersion": 2,
            "manifests": [{"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": manifest_digest, "size": len(manifest)}],
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    members = {
        "oci-layout": b'{"imageLayoutVersion":"1.0.0"}',
        "index.json": index,
        "blobs/sha256/" + config_digest.split(":", 1)[1]: config,
        "blobs/sha256/" + manifest_digest.split(":", 1)[1]: manifest,
    }
    with tarfile.open(filename, "w") as archive:
        for name, content in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.mtime = 0
            archive.addfile(info, io.BytesIO(content))


class OciReproducibilityTests(unittest.TestCase):
    def test_accepts_identical_arm64_non_root_manifests(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = pathlib.Path(directory) / "first.tar"
            second = pathlib.Path(directory) / "second.tar"
            _write_archive(first)
            _write_archive(second)
            result = compare(first, second)
            self.assertEqual(result["architecture"], "arm64")
            self.assertEqual(result["user"], "1000:1000")

    def test_rejects_different_manifest_digests(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = pathlib.Path(directory) / "first.tar"
            second = pathlib.Path(directory) / "second.tar"
            _write_archive(first, marker="one")
            _write_archive(second, marker="two")
            with self.assertRaisesRegex(OciArchiveError, "manifest digests differ"):
                compare(first, second)

    def test_rejects_wrong_architecture_or_root_user(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            wrong_arch = pathlib.Path(directory) / "amd64.tar"
            root_user = pathlib.Path(directory) / "root.tar"
            _write_archive(wrong_arch, architecture="amd64")
            _write_archive(root_user, user="0")
            with self.assertRaisesRegex(OciArchiveError, "Linux ARM64"):
                inspect_archive(wrong_arch)
            with self.assertRaisesRegex(OciArchiveError, "non-root"):
                inspect_archive(root_user)


if __name__ == "__main__":
    unittest.main()
