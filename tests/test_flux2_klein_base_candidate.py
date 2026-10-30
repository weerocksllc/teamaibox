import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "models/drawing-flux2-klein-base-4b-bf16.candidate.v1.json"


class Flux2KleinBaseCandidateTests(unittest.TestCase):
    def test_exact_manifest_and_training_boundary(self):
        value = json.loads(SPEC.read_text(encoding="utf-8"))
        source = value["source"]
        self.assertEqual(source["revision"], "a3b4f4849157f664bdbc776fd7453c2783562f4d")
        self.assertEqual(source["selectedFileCount"], len(source["files"]))
        self.assertEqual(source["selectedTotalBytes"], sum(item["bytes"] for item in source["files"]))
        self.assertEqual(len({item["path"] for item in source["files"]}), len(source["files"]))
        self.assertTrue(all(item["sha256"].startswith("sha256:") for item in source["files"]))
        self.assertEqual(value["license"]["identifier"], "Apache-2.0")
        license_file = next(item for item in source["files"] if item["path"] == "LICENSE.md")
        self.assertEqual(value["license"]["evidenceDigest"], license_file["sha256"])
        self.assertEqual(value["runtime"]["training"]["method"], "lora")
        self.assertEqual(value["runtime"]["resourceMode"], "node-exclusive")


if __name__ == "__main__":
    unittest.main()
