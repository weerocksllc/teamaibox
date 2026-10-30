from pathlib import Path
import json
import unittest


ROOT = Path(__file__).resolve().parents[1]


class Qwen38SourceTests(unittest.TestCase):
    def test_official_source_is_exact_and_complete(self):
        source = json.loads((ROOT / "models/qwen38-27b-bf16.source.v1.json").read_text())
        self.assertEqual(source["repository"], "Qwen/Qwen3.8-27B")
        self.assertEqual(source["revision"], "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0")
        self.assertEqual(source["selectedTotalBytes"], 55586114863)
        self.assertEqual(len(source["weightShards"]), 18)
        self.assertEqual(len({x["sha256"] for x in source["weightShards"]}), 18)

if __name__ == "__main__":
    unittest.main()
