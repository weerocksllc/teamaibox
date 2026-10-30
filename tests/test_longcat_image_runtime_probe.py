from pathlib import Path
import unittest

from tools.longcat_image_runtime_probe import RUN_ID

ROOT = Path(__file__).resolve().parents[1]


class LongCatRuntimeProbeTests(unittest.TestCase):
    def test_probe_is_offline_bounded_and_dual_mode(self):
        source = (ROOT / "tools/longcat_image_runtime_probe.py").read_text(encoding="utf-8")
        self.assertIsNotNone(RUN_ID.fullmatch("longcat-image-runtime-20260901-a1"))
        self.assertIn('kind in {"generation", "edit"}', source)
        self.assertIn("local_files_only=True", source)
        self.assertIn("num_inference_steps=12", source)
        self.assertIn("num_inference_steps=8", source)
        self.assertIn('"schedulerProcessCancellationRequired": True', source)


if __name__ == "__main__":
    unittest.main()
