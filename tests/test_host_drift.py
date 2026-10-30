import copy
import datetime as dt
import json
import pathlib
import tempfile
import unittest

from tools.host_drift import (
    CommandResult,
    HostDriftError,
    capture_snapshot,
    evaluate_snapshot,
    load_exception_keys,
)


NOW = dt.datetime(2026, 8, 10, 12, 0, tzinfo=dt.timezone.utc)


def fake_runner(command, _timeout):
    values = {
        ("uname", "-m"): "aarch64\n",
        ("uname", "-r"): "6.17.0-1026-nvidia\n",
        ("docker", "version", "--format", "{{.Server.Version}}"): "28.3.3\n",
        ("dpkg-query", "-W", "-f=${Version}", "nvidia-container-toolkit"): "1.17.8-1\n",
        ("nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"): "580.159.03\n",
        ("dpkg-query", "-W", "-f=${binary:Package}\t${Version}\\n"): (
            "base-files\t13ubuntu10\n"
            "docker-ce\t5:28.3.3-1~ubuntu.24.04~noble\n"
            "nvidia-container-toolkit\t1.17.8-1\n"
        ),
        ("systemctl", "list-unit-files", "--no-legend", "--no-pager", "--type=service"): (
            "docker.service enabled enabled\nssh.service enabled enabled\n"
        ),
        ("systemctl", "is-active", "docker.service"): "active\n",
        ("systemctl", "is-enabled", "docker.service"): "enabled\n",
    }
    key = tuple(command)
    return CommandResult(0, values[key]) if key in values else CommandResult(127, "")


class HostDriftTests(unittest.TestCase):
    def snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            os_release = root / "os-release"
            os_release.write_text('ID=ubuntu\nVERSION_ID="24.04"\n', encoding="utf-8")
            config = root / "daemon.json"
            config.write_text('{"features":{}}\n', encoding="utf-8")
            return capture_snapshot(
                fake_runner,
                collected_at=NOW,
                os_release_path=os_release,
                config_paths=(str(config),),
            )

    def allowlist(self, snapshot):
        return {
            "schemaVersion": 1,
            "target": "dgx-spark-dev-01",
            "hostInstallPolicy": "deny-unregistered",
            "baseline": {
                "architecture": snapshot["architecture"]["value"],
                "os": {"id": snapshot["os"]["id"], "versionId": snapshot["os"]["versionId"]},
                "kernelRelease": snapshot["kernelRelease"]["value"],
                "foundation": {
                    "docker": snapshot["foundation"]["docker"]["value"],
                    "nvidiaContainerToolkit": snapshot["foundation"]["nvidiaContainerToolkit"]["value"],
                    "nvidiaDriver": snapshot["foundation"]["nvidiaDriver"]["value"],
                },
                "packageState": {
                    "count": snapshot["packageState"]["count"],
                    "digest": snapshot["packageState"]["digest"],
                },
                "serviceState": {
                    "count": snapshot["serviceState"]["count"],
                    "digest": snapshot["serviceState"]["digest"],
                },
                "configurationFingerprints": snapshot["configurationFingerprints"],
            },
        }

    def test_capture_is_sanitized_and_uses_only_read_only_commands(self):
        snapshot = self.snapshot()
        serialized = json.dumps(snapshot)
        self.assertTrue(snapshot["collector"]["readOnly"])
        self.assertNotIn("machine-id", serialized)
        self.assertNotIn("ssh_host", serialized)
        self.assertNotIn('{"features":{}}', serialized)
        self.assertEqual(snapshot["packageState"]["count"], 3)
        self.assertEqual(snapshot["serviceState"]["required"]["docker.service"]["active"], "active")

    def test_matching_snapshot_is_release_eligible(self):
        snapshot = self.snapshot()
        result = evaluate_snapshot(self.allowlist(snapshot), snapshot)
        self.assertTrue(result["conforming"])
        self.assertTrue(result["releaseEvidenceEligible"])
        self.assertFalse(result["mutationPerformed"])
        self.assertEqual(result["drifts"], [])

    def test_package_or_configuration_drift_blocks_release_without_mutation(self):
        snapshot = self.snapshot()
        drifted = copy.deepcopy(snapshot)
        drifted["packageState"]["digest"] = "sha256:" + "0" * 64
        config_name = next(iter(drifted["configurationFingerprints"]))
        drifted["configurationFingerprints"][config_name]["digest"] = "sha256:" + "1" * 64
        result = evaluate_snapshot(self.allowlist(snapshot), drifted)
        self.assertFalse(result["conforming"])
        self.assertFalse(result["releaseEvidenceEligible"])
        self.assertFalse(result["mutationPerformed"])
        self.assertEqual(
            {drift["key"] for drift in result["drifts"]},
            {"packageState.digest", "configurationFingerprint:" + config_name},
        )

    def test_registered_nonexpired_exception_can_accept_exact_drift_keys(self):
        snapshot = self.snapshot()
        drifted = copy.deepcopy(snapshot)
        drifted["packageState"]["digest"] = "sha256:" + "0" * 64
        result = evaluate_snapshot(
            self.allowlist(snapshot),
            drifted,
            accepted_exception_keys={"packageState.digest"},
        )
        self.assertTrue(result["releaseEvidenceEligible"])
        self.assertEqual(result["drifts"][0]["classification"], "registered-exception")

    def test_exception_requires_ownership_rollback_evidence_and_future_expiry(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "bad.json"
            path.write_text(json.dumps({"schemaVersion": 1, "status": "active"}), encoding="utf-8")
            with self.assertRaises(HostDriftError):
                load_exception_keys(path.parent, now=NOW)


if __name__ == "__main__":
    unittest.main()
