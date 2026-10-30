from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ResumableRemoteContainerTests(unittest.TestCase):
    def test_control_plane_is_short_polled_exact_and_bounded(self):
        source = (ROOT / "tools/resumable_remote_container.py").read_text(encoding="utf-8")
        for expected in ("--detach", "{{json .State}}", "attempts: int = 5",
                         "consecutive_control_failures >= 6", "--filter", "name=^/",
                         '"com.teamaibox.run-id=" + run_id', '"rm", "--force", name'):
            self.assertIn(expected, source)

    def test_helper_never_requests_gpu_or_retains_logs(self):
        source = (ROOT / "tools/resumable_remote_container.py").read_text(encoding="utf-8")
        self.assertNotIn('"--gpus"', source)
        self.assertIn('"lastLogSha256Retained": False', source)


if __name__ == "__main__":
    unittest.main()
