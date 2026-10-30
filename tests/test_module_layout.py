from __future__ import annotations

import json
import pathlib
import tempfile
import unittest

from tools.validate_module_layout import CATALOG, LayoutError, ROOT, validate_catalog


class ModuleLayoutTests(unittest.TestCase):
    def test_repository_catalog_is_valid(self) -> None:
        catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
        summary = validate_catalog(catalog, ROOT)
        self.assertGreaterEqual(summary["components"], 12)

    def test_rejects_unknown_dependency(self) -> None:
        catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
        catalog["components"][0]["dependsOn"] = ["not-a-component"]
        with self.assertRaisesRegex(LayoutError, "unknown dependency"):
            validate_catalog(catalog, ROOT)

    def test_rejects_dependency_cycle(self) -> None:
        catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
        by_name = {item["name"]: item for item in catalog["components"]}
        by_name["contracts"]["dependsOn"] = ["platform-api"]
        with self.assertRaisesRegex(LayoutError, "dependency cycle"):
            validate_catalog(catalog, ROOT)

    def test_rejects_missing_component_readme(self) -> None:
        catalog = {
            "schemaVersion": 1,
            "platformVersion": "0.1.0",
            "components": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(LayoutError):
                validate_catalog(catalog, pathlib.Path(directory))


if __name__ == "__main__":
    unittest.main()

