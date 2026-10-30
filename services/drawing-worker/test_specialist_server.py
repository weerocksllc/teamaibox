import importlib.util
import os
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("drawing_specialist",
    Path(__file__).with_name("specialist_server.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SpecialistWorkerTests(unittest.TestCase):
    def test_snapshot_readiness_is_kind_specific(self):
        old_kind, old_root, old_adapter = MODULE.KIND, MODULE.MODEL_ROOT, MODULE.ADAPTER_ROOT
        try:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "model_index.json").write_text("{}")
                adapter = root / "adapter"
                adapter.mkdir()
                (adapter / MODULE.QWEN_WEIGHT).write_bytes(b"x")
                MODULE.KIND, MODULE.MODEL_ROOT, MODULE.ADAPTER_ROOT = (
                    "qwen-image-2512-lightning", root, adapter)
                self.assertTrue(MODULE.snapshot_ready())
                MODULE.KIND = "longcat-image"
                self.assertFalse(MODULE.snapshot_ready())
                (root / "transformer").mkdir()
                (root / "transformer/diffusion_pytorch_model.safetensors").write_bytes(b"x")
                self.assertTrue(MODULE.snapshot_ready())
        finally:
            MODULE.KIND, MODULE.MODEL_ROOT, MODULE.ADAPTER_ROOT = old_kind, old_root, old_adapter

    def test_server_is_generation_only_and_bounded(self):
        source = Path(MODULE.__file__).read_text(encoding="utf-8")
        for expected in ('self.path == "/v1/images/edits"', '"unsupported_operation"',
                         'expected_steps = 4 if KIND', 'else 50', 'PIPELINE = None',
                         'callback_on_step_end'):
            self.assertIn(expected, source)

    def test_cancellation_callback_is_only_attached_to_qwen(self):
        source = Path(MODULE.__file__).read_text(encoding="utf-8")
        start = source.index('if KIND == "qwen-image-2512-lightning":', source.index('arguments = {"prompt"'))
        boundary = source.index("else:", start)
        end = source.index("with PIPELINE_LOCK", boundary)
        self.assertIn('"callback_on_step_end": cancelled', source[start:boundary])
        self.assertNotIn('"callback_on_step_end": cancelled', source[boundary:end])


if __name__ == "__main__":
    unittest.main()
