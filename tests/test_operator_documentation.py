from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import unittest

from tools.validate_operator_documentation import CATALOG, validate


class OperatorDocumentationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog = json.loads(Path(CATALOG).read_text(encoding="utf-8"))

    def validate_mutation(self, value: dict) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "catalog.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            validate(path)

    def test_committed_operator_documentation_is_complete(self) -> None:
        self.assertEqual(
            validate(),
            {"valid": True, "documentCount": 11, "sectionCount": 56, "audienceCount": 12},
        )

    def test_rejects_missing_topic_and_non_release_blocking_catalog(self) -> None:
        missing = copy.deepcopy(self.catalog)
        missing["documents"].pop()
        with self.assertRaisesRegex(ValueError, "topic coverage"):
            self.validate_mutation(missing)

        advisory = copy.deepcopy(self.catalog)
        advisory["releaseBlocking"] = False
        with self.assertRaisesRegex(ValueError, "release blocking"):
            self.validate_mutation(advisory)

    def test_rejects_missing_file_section_and_reference(self) -> None:
        missing_file = copy.deepcopy(self.catalog)
        missing_file["documents"][0]["path"] = "docs/operations/does-not-exist.md"
        with self.assertRaisesRegex(ValueError, "file is missing"):
            self.validate_mutation(missing_file)

        section = copy.deepcopy(self.catalog)
        section["documents"][0]["requiredSections"].append("Imaginary release step")
        with self.assertRaisesRegex(ValueError, "missing required sections"):
            self.validate_mutation(section)

        reference = copy.deepcopy(self.catalog)
        reference["documents"][0]["requiredReferences"].append("imaginary-reference-token")
        with self.assertRaisesRegex(ValueError, "missing required references"):
            self.validate_mutation(reference)


if __name__ == "__main__":
    unittest.main()
