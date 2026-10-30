from __future__ import annotations

import unittest

from tools.flux2_klein_comfyui_probe import (
    CLIP_NAME,
    MODEL_NAME,
    RUN_ID,
    VAE_NAME,
    edit,
    generation,
)


class Flux2KleinComfyProbeTests(unittest.TestCase):
    def test_identity_and_exact_components(self) -> None:
        self.assertIsNotNone(RUN_ID.fullmatch("flux2-klein-runtime-20260831-a4"))
        self.assertEqual(MODEL_NAME, "flux-2-klein-4b-nvfp4.safetensors")
        self.assertEqual(CLIP_NAME, "qwen_3_4b.safetensors")
        self.assertEqual(VAE_NAME, "full_encoder_small_decoder.safetensors")

    def test_generation_uses_four_step_distilled_workflow(self) -> None:
        value = generation("prompt", 7, "output")
        self.assertEqual(value["10"]["inputs"]["steps"], 4)
        self.assertEqual(value["8"]["inputs"]["cfg"], 1.0)
        self.assertEqual(value["13"]["class_type"], "SaveImage")

    def test_edit_and_multi_reference_are_distinct(self) -> None:
        single = edit("prompt", 8, "single", 1)
        multiple = edit("prompt", 9, "multiple", 2)
        self.assertNotIn("19", single)
        self.assertEqual(multiple["14"]["inputs"]["positive"], ["21", 0])
        self.assertEqual(multiple["14"]["inputs"]["negative"], ["22", 0])


if __name__ == "__main__":
    unittest.main()
