from __future__ import annotations

import unittest

from tools.flux2_worker_protocol_probe import RUN_ID, request_body


class Flux2WorkerProtocolTests(unittest.TestCase):
    def test_identity_and_distilled_defaults(self) -> None:
        self.assertIsNotNone(RUN_ID.fullmatch("flux2-worker-protocol-20260831-a1"))
        value = request_body("10000000-0000-4000-8000-000000000001", "prompt", 9)
        self.assertEqual(value["model"], "flux2-klein-4b-nvfp4")
        self.assertEqual(value["x_teamaibox"]["steps"], 4)
        self.assertEqual(value["x_teamaibox"]["guidance_scale"], 1.0)

    def test_edit_reference_extension_is_explicit(self) -> None:
        value = request_body("10000000-0000-4000-8000-000000000001", "prompt", 9,
                             image="one", references=["two"])
        self.assertEqual(value["image_b64"], "one")
        self.assertEqual(value["x_teamaibox"]["reference_images_b64"], ["two"])


if __name__ == "__main__":
    unittest.main()
