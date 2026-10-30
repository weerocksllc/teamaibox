import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from tools.pack_protected_office_bundle import pack


class PackProtectedOfficeBundleTests(unittest.TestCase):
    def test_roundtrip_contains_only_exact_manifest_files_and_is_immutable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "bundle"
            bundle.mkdir()
            (bundle / "schema.sql").write_bytes(b"SELECT 1;")
            (bundle / "._schema.sql").write_bytes(b"macOS metadata")
            (bundle / "bundle-manifest.json").write_text(json.dumps({"files": [{
                "path": "schema.sql", "sha256": "sha256:" + hashlib.sha256(b"SELECT 1;").hexdigest(),
            }]}))
            archive = root / "bundle.tar"
            self.assertEqual(pack(bundle, archive), 2)
            with tarfile.open(archive) as reader:
                self.assertEqual(reader.getnames(), ["bundle-manifest.json", "schema.sql"])
                self.assertTrue(all(x.isreg() and not x.pax_headers and x.uid == 0 for x in reader))
                self.assertEqual(reader.extractfile("schema.sql").read(), b"SELECT 1;")
            with self.assertRaises(FileExistsError):
                pack(bundle, archive)
            (bundle / "schema.sql").write_bytes(b"drift")
            with self.assertRaisesRegex(ValueError, "digest drifted"):
                pack(bundle, root / "bad.tar")
            self.assertFalse((root / "bad.tar").exists())

    def test_rejects_unbounded_and_metadata_members(self):
        for name in ("../escape", "/escape", "._schema.sql", "a/../escape", "a\\b"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "bundle-manifest.json").write_text(json.dumps({"files": [{
                    "path": name, "sha256": "sha256:" + "0" * 64,
                }]}))
                with self.assertRaises(ValueError):
                    pack(root, root / "bad.tar")
