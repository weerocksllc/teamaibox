import json
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class ZImageTurboCandidateTests(unittest.TestCase):
    def test_spec_pins_exact_public_candidate_and_generation_only_boundary(self):
        value = json.loads((ROOT / "models/drawing-z-image-turbo-bf16.candidate.v1.json").read_text())
        self.assertEqual(value["source"]["repository"], "Tongyi-MAI/Z-Image-Turbo")
        self.assertEqual(value["source"]["revision"], "f332072aa78be7aecdf3ee76d5c247082da564a6")
        self.assertEqual(value["source"]["selectedFileCount"], 20)
        self.assertEqual(value["source"]["selectedTotalBytes"], 32848319217)
        self.assertEqual(sum(item["bytes"] for item in value["source"]["files"]), 32848319217)
        self.assertEqual(len({item["path"] for item in value["source"]["files"]}), 20)
        self.assertEqual(value["runtime"]["capabilities"],
                         {"generation": True, "editing": False, "multiReference": False})

if __name__ == "__main__":
    unittest.main()
