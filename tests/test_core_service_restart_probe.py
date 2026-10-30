from __future__ import annotations

from pathlib import Path
import unittest

from tools.core_service_restart_probe import DIGEST_IMAGE, SAFE_PREFIX, RestartProbeError, parse_loopback_port


ROOT = Path(__file__).resolve().parents[1]


class CoreServiceRestartProbeTests(unittest.TestCase):
    def test_dynamic_nats_mapping_is_strictly_reparsed_after_restart(self) -> None:
        self.assertEqual(parse_loopback_port("127.0.0.1:32768\n"), 32768)
        for value in ("0.0.0.0:32768", "127.0.0.1:0", "127.0.0.1:65536", "not-a-port"):
            with self.assertRaises(RestartProbeError):
                parse_loopback_port(value)

    def test_probe_names_and_images_are_strictly_bounded(self) -> None:
        self.assertIsNotNone(SAFE_PREFIX.fullmatch("teamaibox-restart-core-restarts-20260812-a1-"))
        self.assertIsNone(SAFE_PREFIX.fullmatch("teamaibox-restart-../../host-"))
        self.assertIsNotNone(DIGEST_IMAGE.fullmatch("docker.io/library/node@sha256:" + "a" * 64))
        self.assertIsNone(DIGEST_IMAGE.fullmatch("node:latest"))

    def test_probe_covers_every_real_container_restart_and_persistence_boundary(self) -> None:
        source = (ROOT / "tools/core_service_restart_probe.py").read_text(encoding="utf-8")
        for key in ("platform", "web", "object", "messaging", "scheduler", "postgres", "nats"):
            self.assertIn(f'"{key}"', source)
        for marker in (
            "docker\", \"kill", "ExitCode", "OOMKilled", "sameContainer",
            "databasePersistence", "eventBusPersistence", "TAIB_RESTART",
            "otherCoreServicesAvailableDuringEachRestart", "residualContainers",
            "NATS mapped port after restart", "wait_nats_request",
        ):
            self.assertIn(marker, source)
        self.assertIn('"residualContainers": bool(residual.stdout.strip())', source)


if __name__ == "__main__":
    unittest.main()
