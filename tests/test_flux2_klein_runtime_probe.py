from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from tools.flux2_klein_runtime_probe import PROFILES, RUN_ID, case_plan, load_pipeline


class Flux2KleinRuntimeProbeTests(unittest.TestCase):
    def test_profile_and_run_identity_are_bounded(self) -> None:
        self.assertEqual(PROFILES, {"bf16", "nvfp4"})
        self.assertIsNotNone(RUN_ID.fullmatch("flux2-klein-runtime-20260831-a1"))
        self.assertIsNone(RUN_ID.fullmatch("../flux2-klein-runtime-20260831-a1"))

    def test_comparable_case_plan_covers_required_operations(self) -> None:
        value = case_plan()
        self.assertEqual([item["key"] for item in value], ["generation", "edit", "multi-reference"])
        self.assertEqual(len({item["seed"] for item in value}), 3)
        self.assertTrue(all(item["prompt"] for item in value))

    def test_nvfp4_loader_passes_diffusers_local_paths_as_strings(self) -> None:
        calls: dict[str, object] = {}

        class Transformer:
            @staticmethod
            def from_single_file(path: str, **kwargs: object) -> object:
                calls["transformerPath"] = path
                calls["transformerArguments"] = kwargs
                return "transformer"

        class Pipeline:
            @staticmethod
            def from_pretrained(path: str, **kwargs: object) -> object:
                calls["pipelinePath"] = path
                calls["pipelineArguments"] = kwargs
                return "pipeline"

        class Torch:
            bfloat16 = "bf16"

        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "base" / "transformer").mkdir(parents=True)
            (root / "base" / "transformer" / "config.json").write_text("{}", encoding="utf-8")
            (root / "nvfp4").mkdir()
            (root / "nvfp4" / "flux-2-klein-4b-nvfp4.safetensors").touch()
            self.assertEqual(load_pipeline("nvfp4", root, Torch, (Pipeline, Transformer)), "pipeline")

        self.assertIsInstance(calls["transformerPath"], str)
        self.assertIsInstance(calls["transformerArguments"]["config"], str)  # type: ignore[index]
        self.assertIsInstance(calls["pipelinePath"], str)
        self.assertEqual(calls["pipelineArguments"]["transformer"], "transformer")  # type: ignore[index]


if __name__ == "__main__":
    unittest.main()
