import pathlib
import unittest

from tools.z_image_turbo_runtime_probe import RUN_ID, cases


ROOT = pathlib.Path(__file__).resolve().parents[1]


class ZImageTurboRuntimeProbeTests(unittest.TestCase):
    def test_identity_and_quality_slices_are_bounded(self):
        self.assertIsNotNone(RUN_ID.fullmatch("z-image-turbo-runtime-20260901-a1"))
        self.assertIsNone(RUN_ID.fullmatch("../z-image-turbo-runtime-20260901-a1"))
        plan = cases()
        self.assertEqual([item["key"] for item in plan],
                         ["english-text", "chinese-text", "portrait", "product-a", "product-b"])
        self.assertEqual(len({item["seed"] for item in plan}), 5)

    def test_probe_is_generation_only_and_cancellable(self):
        source = (ROOT / "tools/z_image_turbo_runtime_probe.py").read_text()
        self.assertIn('"capabilities": {"generation": True, "editing": False, "multiReference": False}', source)
        self.assertIn("callback_on_step_end=cancel", source)
        self.assertIn("torch.cuda.max_memory_allocated()", source)
        self.assertIn("torch.cuda.empty_cache()", source)
        self.assertIn('cycle in {"cycle1", "cycle2"}', source)


if __name__ == "__main__":
    unittest.main()
