import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class GlmImageRuntimeProbeTests(unittest.TestCase):
    def test_generation_edit_multi_reference_and_cancel_are_real(self):
        source = (ROOT / "tools/glm_image_runtime_probe.py").read_text(encoding="utf-8")
        self.assertIn("GlmImagePipeline.from_pretrained", source)
        self.assertIn('("edit", 62103, [first]', source)
        self.assertIn('("multi-reference", 62104, [first, second]', source)
        self.assertIn("callback_on_step_end=cancel", source)
        self.assertIn('num_inference_steps=20', source)

    def test_pipeline_is_offline_bf16_and_explicitly_unloaded(self):
        source = (ROOT / "tools/glm_image_runtime_probe.py").read_text(encoding="utf-8")
        self.assertIn("torch_dtype=torch.bfloat16", source)
        self.assertIn("local_files_only=True", source)
        self.assertIn('device_map="cuda"', source)
        self.assertIn("torch.cuda.empty_cache()", source)


if __name__ == "__main__":
    unittest.main()
