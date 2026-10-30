from pathlib import Path
import unittest

from tools.qwen_image_2512_lightning_runtime_probe import RUN_ID, WEIGHT

ROOT = Path(__file__).resolve().parents[1]


class QwenRuntimeProbeTests(unittest.TestCase):
    def test_exact_lightning_runtime_contract(self):
        self.assertIsNotNone(RUN_ID.fullmatch("qwen-image-2512-lightning-runtime-20260901-a1"))
        self.assertEqual(WEIGHT, "Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors")
        source = (ROOT / "tools/qwen_image_2512_lightning_runtime_probe.py").read_text(encoding="utf-8")
        for expected in ("FlowMatchEulerDiscreteScheduler", "base_shift", "math.log(3)",
                         "load_lora_weights", "num_inference_steps=4", "local_files_only=True"):
            self.assertIn(expected, source)
        self.assertIn("ExpectedCancellation", source)


if __name__ == "__main__":
    unittest.main()
