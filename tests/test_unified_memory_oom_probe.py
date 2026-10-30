from __future__ import annotations

import unittest

from tools.unified_memory_oom_probe import probe


class UnifiedMemoryOomProbeTests(unittest.TestCase):
    def test_rejects_broad_container_names_before_docker(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe"):
            probe("teamaibox", "docker.io/library/node@sha256:" + "a" * 64)

    def test_rejects_mutable_or_non_node_images_before_docker(self) -> None:
        for image in ("node:latest", "docker.io/library/postgres@sha256:" + "a" * 64):
            with self.subTest(image=image), self.assertRaisesRegex(ValueError, "locked Node"):
                probe("teamaibox-validation-memory-a1-oom", image)


if __name__ == "__main__":
    unittest.main()
