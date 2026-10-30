import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class QwenImage2512LightningCandidateSpecTests(unittest.TestCase):
    def test_exact_base_and_adapter_are_selected_without_unrelated_107gb_variants(self):
        value = json.loads((ROOT / "models/drawing-qwen-image-2512-lightning-bf16.candidate.v1.json").read_text())
        base = value["source"]["base"]
        adapter = value["source"]["adapter"]
        self.assertEqual(base["revision"], "25468b98e3276ca6700de15c6628e51b7de54a26")
        self.assertEqual(adapter["revision"], "a52649c9d0f6e1a248bff13f0df33bb8a2abdb52")
        self.assertEqual(base["selectedFileCount"], len(base["files"]))
        self.assertEqual(adapter["selectedFileCount"], len(adapter["files"]))
        self.assertEqual(sum(item["bytes"] for item in base["files"]), 57704594216)
        self.assertEqual(sum(item["bytes"] for item in adapter["files"]), 849609298)
        self.assertEqual(value["source"]["selectedTotalBytes"], 58554203514)
        self.assertEqual([item["path"] for item in adapter["files"]],
                         ["Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors", "README.md"])
        self.assertTrue(all(re.fullmatch(r"sha256:[0-9a-f]{64}", item["sha256"])
                            for item in [*base["files"], *adapter["files"]]))

    def test_runtime_is_generation_only_four_step_bf16_lora(self):
        value = json.loads((ROOT / "models/drawing-qwen-image-2512-lightning-bf16.candidate.v1.json").read_text())
        self.assertEqual(value["runtime"]["pipeline"], "QwenImagePipeline")
        self.assertEqual(value["runtime"]["precision"], "bf16")
        self.assertEqual(value["runtime"]["inferenceSteps"], 4)
        self.assertEqual(value["runtime"]["guidanceScale"], 1.0)
        self.assertEqual(value["runtime"]["capabilities"],
                         {"generation": True, "editing": False, "multiReference": False})


if __name__ == "__main__":
    unittest.main()
