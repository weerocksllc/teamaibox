import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import download_layout_model as model


class LayoutModelImporterTests(unittest.TestCase):
    def test_verified_requires_exact_manifest_and_file_digests(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            content = b"onnx"
            path = root / "PP-DocLayoutV3.onnx"
            path.write_bytes(content)
            digest = "sha256:" + hashlib.sha256(content).hexdigest()
            manifest = {
                "model": model.MODEL_NAME,
                "sourceRepository": model.SOURCE_REPOSITORY,
                "sourceRevision": model.SOURCE_REVISION,
                "sourcePath": model.SOURCE_PATH,
                "files": [{"path": path.name, "sha256": digest, "size": len(content)}],
            }
            (root / "teamaibox-model-manifest.json").write_text(json.dumps(manifest))
            with mock.patch.object(model, "MODEL_ROOT", root), mock.patch.object(
                model, "MANIFEST", root / "teamaibox-model-manifest.json"
            ), mock.patch.object(model, "MODEL_FILE", path), mock.patch.object(
                model, "EXPECTED_SIZE", len(content)
            ), mock.patch.object(model, "EXPECTED_SHA256", digest):
                self.assertTrue(model.verified())
                path.write_bytes(b"changed")
                self.assertFalse(model.verified())


if __name__ == "__main__":
    unittest.main()
