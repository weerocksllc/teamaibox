import json
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class GlmImageCandidateTests(unittest.TestCase):
    def test_exact_revision_manifest_license_and_capabilities(self):
        value = json.loads((ROOT / "models/drawing-glm-image-bf16.candidate.v1.json").read_text())
        self.assertEqual(value["source"]["repository"], "zai-org/GLM-Image")
        self.assertEqual(value["source"]["revision"], "2c433cc0cbc293bde2ac8ca9624f279b5d23fcf4")
        self.assertEqual(value["source"]["selectedFileCount"], 26)
        self.assertEqual(value["source"]["selectedTotalBytes"], 35789280648)
        self.assertEqual(sum(item["bytes"] for item in value["source"]["files"]), 35789280648)
        self.assertEqual(len({item["path"] for item in value["source"]["files"]}), 26)
        self.assertEqual(value["license"]["reviewState"], "approved")
        self.assertEqual(value["runtime"]["capabilities"],
                         {"generation": True, "editing": True, "multiReference": True})

if __name__ == "__main__":
    unittest.main()
