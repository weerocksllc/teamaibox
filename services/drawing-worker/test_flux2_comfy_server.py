from __future__ import annotations

import unittest

try:
    # The runtime image installs this module directly; exercise those exact
    # bytes, not a second checkout mounted by the test harness.
    from flux2_comfy_server import (
        JOB_ID, MAX_REFERENCES, WorkerError, edit_workflow, generation_workflow,
    )
except ModuleNotFoundError as error:
    if error.name != "flux2_comfy_server":
        raise
    from services.drawing_worker.flux2_comfy_server import (
        JOB_ID, MAX_REFERENCES, WorkerError, edit_workflow, generation_workflow,
    )


class Flux2ComfyServerTests(unittest.TestCase):
    def test_generation_is_distilled_and_bounded(self) -> None:
        workflow = generation_workflow("prompt", 7, "safe", 768, 512, 4)
        self.assertEqual(workflow["8"]["inputs"]["cfg"], 1.0)
        self.assertEqual(workflow["10"]["inputs"], {"steps": 4, "width": 768, "height": 512})
        self.assertEqual(workflow["13"]["class_type"], "SaveImage")

    def test_edit_chains_up_to_three_reference_latents(self) -> None:
        workflow = edit_workflow("prompt", 8, "safe", ["one.png", "two.png", "three.png"], 512, 512, 4)
        self.assertEqual(MAX_REFERENCES, 3)
        self.assertEqual(workflow["10"]["inputs"]["positive"], ["30", 0])
        self.assertEqual(workflow["10"]["inputs"]["negative"], ["31", 0])
        with self.assertRaises(WorkerError):
            edit_workflow("prompt", 8, "safe", [], 512, 512, 4)

    def test_job_identity_is_fail_closed(self) -> None:
        self.assertIsNotNone(JOB_ID.fullmatch("00000000-0000-4000-8000-000000000001"))
        self.assertIsNone(JOB_ID.fullmatch("../00000000-0000-4000-8000-000000000001"))


if __name__ == "__main__":
    unittest.main()
