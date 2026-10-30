import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class LongCatImageCandidateSpecTests(unittest.TestCase):
    def load(self, name):
        return json.loads((ROOT / "models" / name).read_text(encoding="utf-8"))

    def assert_manifest(self, value, count, total):
        files = value["source"]["files"]
        self.assertEqual(value["source"]["selectedFileCount"], count)
        self.assertEqual(len(files), count)
        self.assertEqual(value["source"]["selectedTotalBytes"], total)
        self.assertEqual(sum(item["bytes"] for item in files), total)
        self.assertEqual(len({item["path"] for item in files}), count)
        self.assertTrue(all(re.fullmatch(r"sha256:[0-9a-f]{64}", item["sha256"])
                            for item in files))

    def test_generation_candidate_is_exact_and_generation_only(self):
        value = self.load("drawing-longcat-image-bf16.candidate.v1.json")
        self.assertEqual(value["source"]["revision"], "d2ea50b79a930074c37b9b97ce45e3b2ea8cf4d8")
        self.assert_manifest(value, 31, 29316539391)
        self.assertEqual(value["runtime"]["pipeline"], "LongCatImagePipeline")
        self.assertEqual(value["runtime"]["capabilities"],
                         {"generation": True, "editing": False, "multiReference": False})
        self.assertEqual(value["runtime"]["guidanceScale"], 4.0)

    def test_edit_candidate_is_exact_and_edit_only(self):
        value = self.load("drawing-longcat-image-edit-turbo-bf16.candidate.v1.json")
        self.assertEqual(value["source"]["revision"], "6a7262de5549f0bf0ec54c08ef7d283ef41f3214")
        self.assert_manifest(value, 32, 29316538042)
        self.assertEqual(value["runtime"]["pipeline"], "LongCatImageEditPipeline")
        self.assertEqual(value["runtime"]["capabilities"],
                         {"generation": False, "editing": True, "multiReference": False})
        self.assertEqual(value["runtime"]["inferenceSteps"], 8)


if __name__ == "__main__":
    unittest.main()
