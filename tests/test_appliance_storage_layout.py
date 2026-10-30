from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.validate_appliance_storage_layout import LAYOUT, validate


class ApplianceStorageLayoutTests(unittest.TestCase):
    def test_committed_layout_covers_every_protected_class_and_compose_path(self) -> None:
        result = validate()
        self.assertTrue(result["valid"])
        self.assertEqual(result["staticPathCount"], 21)
        self.assertEqual(result["dynamicPathCount"], 5)
        self.assertEqual(result["composeVolumeCount"], 21)
        self.assertEqual(result["coveredClasses"], ["audit", "cache", "database", "model", "object", "plugin", "workspace"])

    def test_layout_rejects_team_data_in_the_pre_unlock_runtime(self) -> None:
        document = json.loads(LAYOUT.read_text(encoding="utf-8"))
        document["bootRecovery"]["forbiddenClasses"].remove("object_blob")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "layout.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "forbidden data classes"):
                validate(path)

    def test_layout_rejects_unprotected_dynamic_docker_storage(self) -> None:
        document = json.loads(LAYOUT.read_text(encoding="utf-8"))
        document["dynamicMappings"][0]["dockerStorage"] = "named-volume"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "layout.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "protected bind"):
                validate(path)


if __name__ == "__main__":
    unittest.main()
