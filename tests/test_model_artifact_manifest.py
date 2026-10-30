import pathlib
import tempfile
import unittest

from tools import model_artifact_manifest as manifest


class ModelArtifactManifestTest(unittest.TestCase):
    def _runtime_files(self, root):
        for name in manifest.REQUIRED_RUNTIME_FILES:
            if name == "model.safetensors.index.json":
                (root / name).write_text('{"weight_map":{"weight":"model.safetensors"}}', encoding="utf-8")
                continue
            path = root / name
            if not path.exists():
                path.write_text("{}" if name.endswith(".json") else "content", encoding="utf-8")

    def test_hashes_allowlisted_files_and_ignores_transfer_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self._runtime_files(root)
            (root / "model.safetensors").write_bytes(b"weights")
            (root / ".cache").mkdir()
            (root / ".cache" / "download.lock").write_text("state", encoding="utf-8")
            result = manifest.build_manifest(
                root, candidate_id="candidate", repository="owner/model",
                revision="a" * 40, maximum_bytes=100,
            )
            self.assertEqual(result["fileCount"], 8)
            self.assertRegex(result["artifactDigest"], r"^sha256:[a-f0-9]{64}$")
            self.assertIn("model.safetensors", [item["path"] for item in result["files"]])

    def test_sharded_snapshot_requires_every_indexed_weight(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self._runtime_files(root)
            (root / "model-00001-of-00002.safetensors").write_bytes(b"one")
            (root / "model.safetensors.index.json").write_text(
                '{"weight_map":{"a":"model-00001-of-00002.safetensors","b":"model-00002-of-00002.safetensors"}}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(manifest.ManifestError, "missing 1 indexed"):
                manifest.collect(root, manifest.DEFAULT_PATTERNS, 1000)
            (root / "model-00002-of-00002.safetensors").write_bytes(b"two")
            files, _total = manifest.collect(root, manifest.DEFAULT_PATTERNS, 1000)
            self.assertEqual(len([item for item in files if item["path"].endswith(".safetensors")]), 2)

    def test_rejects_unknown_empty_symlink_oversize_and_missing_weights(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self._runtime_files(root)
            with self.assertRaises(manifest.ManifestError):
                manifest.collect(root, manifest.DEFAULT_PATTERNS, 100)
            (root / "model.safetensors").write_bytes(b"weights")
            (root / "README.md").write_text("not allowlisted", encoding="utf-8")
            with self.assertRaises(manifest.ManifestError):
                manifest.collect(root, manifest.DEFAULT_PATTERNS, 1000)
            (root / "README.md").unlink()
            with self.assertRaises(manifest.ManifestError):
                manifest.collect(root, manifest.DEFAULT_PATTERNS, 1)
            (root / "empty.json").write_bytes(b"")
            with self.assertRaises(manifest.ManifestError):
                manifest.collect(root, manifest.DEFAULT_PATTERNS, 1000)
            (root / "empty.json").unlink()
            (root / "link.json").symlink_to(root / "config.json")
            with self.assertRaises(manifest.ManifestError):
                manifest.collect(root, manifest.DEFAULT_PATTERNS, 1000)


if __name__ == "__main__":
    unittest.main()
