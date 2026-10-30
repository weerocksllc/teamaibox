from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from services.trusted_media_service.host_exception_guard import evaluate_host_exceptions
from services.trusted_media_service.package_admission import PackageAdmissionGate
from services.trusted_media_service.release_controller import MediaReleaseController, MediaReleaseError
from tools.create_trusted_media_rootfs_manifest import REQUIRED_EXECUTABLES, create_manifest
from tools.validate_trusted_media_service_scaffold import ROOT, validate


def release(number: int) -> dict[str, object]:
    return {
        "releaseId": f"trusted-media-v{number}",
        "architecture": "linux/arm64/v8",
        "trustedMediaImageDigest": "sha256:" + str(number) * 64,
        "sfuImageDigest": "sha256:" + "a" * 64,
        "runtimePolicyDigest": "sha256:" + "b" * 64,
        "sourceLockDigest": "sha256:" + "c" * 64,
        "hardwareEvidenceDigest": "sha256:" + "d" * 64,
        "rootfsManifestDigest": "sha256:" + "e" * 64,
        "releaseEligible": True,
        "hardwareSupported": True,
        "healthTimeoutSeconds": 30,
    }


class FakeRuntime:
    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []
        self.unhealthy: set[str] = set()
        self.interrupt_start: set[str] = set()
        self.fail_operations: set[str] = set()

    @staticmethod
    def identity(value: dict[str, object]) -> str:
        return str(value["releaseId"])

    def start(self, value):
        identity = self.identity(value)
        self.events.append(("start", identity))
        if identity in self.interrupt_start:
            raise KeyboardInterrupt("simulated process death")

    def wait_healthy(self, value, timeout_seconds):
        identity = self.identity(value)
        self.events.append((f"healthy:{timeout_seconds}", identity))
        return identity not in self.unhealthy

    def withdraw_discovery(self, value):
        self.events.append(("withdraw", self.identity(value)))
        if "withdraw" in self.fail_operations:
            raise RuntimeError("synthetic withdrawal failure")

    def stop(self, value):
        self.events.append(("stop", self.identity(value)))
        if "stop" in self.fail_operations:
            raise RuntimeError("synthetic stop failure")

    def clear_ephemeral_state(self, value):
        self.events.append(("clear", self.identity(value)))
        if "clear" in self.fail_operations:
            raise RuntimeError("synthetic clear failure")

    def remove(self, value):
        self.events.append(("remove", self.identity(value)))
        if "remove" in self.fail_operations:
            raise RuntimeError("synthetic remove failure")


class TrustedMediaServiceScaffoldTest(unittest.TestCase):
    def controller(self, root: Path, runtime: FakeRuntime) -> MediaReleaseController:
        return MediaReleaseController(state_directory=root, runtime=runtime, admission_check=lambda _release: ())

    def test_committed_scaffold_is_valid_but_cannot_complete_task_22_3(self) -> None:
        result = validate()
        self.assertTrue(result["valid"])
        self.assertTrue(result["sourceScaffoldReady"])
        self.assertFalse(result["deployable"])
        self.assertFalse(result["componentReady"])
        self.assertFalse(result["task22_3Complete"])
        self.assertEqual(result["legalGateCount"], 5)

    def test_current_package_admission_fails_closed_on_legal_hardware_and_image(self) -> None:
        gate = PackageAdmissionGate(
            repository_root=ROOT,
            package_path=ROOT / "deploy/casting/trusted-media-service.package.v1.json",
        )
        blockers = set(gate(release(1)))
        self.assertIn("airplay_supply_chain_human_decisions_pending", blockers)
        self.assertIn("hdmi_sink_disconnected", blockers)
        self.assertIn("hdmi_1080p30_not_proven", blockers)
        self.assertIn("hdmi_audio_sink_not_proven", blockers)
        self.assertIn("h264_encoder_plugin_missing", blockers)
        self.assertIn("webrtc_plugin_missing", blockers)
        self.assertIn("trusted_media_arm64_image_unbuilt", blockers)

    def test_open_source_v2_package_passes_22_1_but_keeps_hardware_activation_closed(self) -> None:
        package_path = ROOT / "deploy/casting/trusted-media-service.package.v2.json"
        package = json.loads(package_path.read_text(encoding="utf-8"))
        value = {
            "releaseId": "trusted-media-open-source-v2",
            "architecture": "linux/arm64/v8",
            "trustedMediaImageDigest": package["images"]["trustedMediaService"]["arm64Digest"],
            "sfuImageDigest": package["images"]["internalSfu"]["arm64Digest"],
            "runtimePolicyDigest": package["policies"]["runtime"]["sha256"],
            "sourceLockDigest": package["sourceLock"]["sha256"],
            "hardwareEvidenceDigest": package["hardwareInventory"]["evidenceDigest"],
            "openSourceReleaseEvidenceDigest": package["releaseMinimumEvidence"]["evidenceDigest"],
            "releaseEligible": True,
            "hardwareSupported": False,
            "healthTimeoutSeconds": 30,
        }
        blockers = set(PackageAdmissionGate(repository_root=ROOT, package_path=package_path)(value))
        self.assertNotIn("airplay_supply_chain_human_decisions_pending", blockers)
        self.assertNotIn("open_source_release_minimum_not_verified", blockers)
        self.assertNotIn("trusted_media_arm64_image_unbuilt", blockers)
        self.assertNotIn("trusted_media_image_signature_missing", blockers)
        self.assertNotIn("trusted_media_spdx_sbom_missing", blockers)
        self.assertNotIn("trusted_media_vulnerability_acceptance_missing", blockers)
        self.assertIn("hardware_supported_environment_not_yet_proven", blockers)
        self.assertIn("release_descriptor_not_eligible", blockers)

    def test_activate_upgrade_persist_rollback_and_uninstall_exact_releases(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = FakeRuntime()
            controller = self.controller(root, runtime)
            controller.initialize()
            first, second = release(1), release(2)
            controller.stage(first)
            state = controller.activate(transaction_id="install-first", trusted_media_image_digest=str(first["trustedMediaImageDigest"]))
            self.assertEqual(state["active"]["releaseId"], "trusted-media-v1")
            controller.stage(second)
            state = controller.upgrade(transaction_id="upgrade-second", trusted_media_image_digest=str(second["trustedMediaImageDigest"]))
            self.assertEqual(state["active"]["releaseId"], "trusted-media-v2")
            self.assertEqual(state["previous"]["releaseId"], "trusted-media-v1")
            self.assertEqual(
                runtime.events[-5:],
                [
                    ("withdraw", "trusted-media-v1"),
                    ("stop", "trusted-media-v1"),
                    ("clear", "trusted-media-v1"),
                    ("start", "trusted-media-v2"),
                    ("healthy:30", "trusted-media-v2"),
                ],
            )
            reloaded = self.controller(root, runtime)
            self.assertEqual(reloaded.initialize()["active"]["trustedMediaImageDigest"], second["trustedMediaImageDigest"])
            state = reloaded.rollback(transaction_id="rollback-first")
            self.assertEqual(state["active"]["releaseId"], "trusted-media-v1")
            self.assertEqual(state["previous"]["releaseId"], "trusted-media-v2")
            state = reloaded.uninstall(transaction_id="uninstall-all")
            self.assertIsNone(state["active"])
            self.assertIsNone(state["previous"])
            self.assertFalse(state["activeRunning"])

    def test_failed_upgrade_removes_candidate_and_restores_prior_health(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = FakeRuntime()
            controller = self.controller(Path(directory), runtime)
            controller.initialize()
            first, second = release(1), release(2)
            controller.stage(first)
            controller.activate(transaction_id="install-first", trusted_media_image_digest=str(first["trustedMediaImageDigest"]))
            runtime.unhealthy.add("trusted-media-v2")
            controller.stage(second)
            with self.assertRaisesRegex(MediaReleaseError, "candidate media release") as caught:
                controller.upgrade(transaction_id="upgrade-bad", trusted_media_image_digest=str(second["trustedMediaImageDigest"]))
            self.assertEqual(caught.exception.code, "media_release_activation_failed")
            state = controller.status()
            self.assertEqual(state["active"]["releaseId"], "trusted-media-v1")
            self.assertTrue(state["activeRunning"])
            self.assertFalse(state["degraded"])
            self.assertIn(("remove", "trusted-media-v2"), runtime.events)
            self.assertEqual(runtime.events[-2:], [("start", "trusted-media-v1"), ("healthy:30", "trusted-media-v1")])

    def test_interrupted_upgrade_recovers_from_fsync_journal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = FakeRuntime()
            controller = self.controller(root, runtime)
            controller.initialize()
            first, second = release(1), release(2)
            controller.stage(first)
            controller.activate(transaction_id="install-first", trusted_media_image_digest=str(first["trustedMediaImageDigest"]))
            controller.stage(second)
            runtime.interrupt_start.add("trusted-media-v2")
            with self.assertRaises(KeyboardInterrupt):
                controller.upgrade(transaction_id="crash-upgrade", trusted_media_image_digest=str(second["trustedMediaImageDigest"]))
            runtime.interrupt_start.clear()
            recovered = self.controller(root, runtime).initialize()
            self.assertEqual(recovered["active"]["releaseId"], "trusted-media-v1")
            self.assertEqual(recovered["lastFailureCode"], "media_release_interrupted_rolled_back")
            self.assertIsNone(recovered["transaction"])
            self.assertIn(("remove", "trusted-media-v2"), runtime.events)

    def test_interrupted_start_recovers_installed_identity_as_stopped_without_removal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = FakeRuntime()
            controller = self.controller(root, runtime)
            controller.initialize()
            first = release(1)
            controller.stage(first)
            controller.activate(transaction_id="install-first", trusted_media_image_digest=str(first["trustedMediaImageDigest"]))
            controller.stop(transaction_id="stop-first")
            runtime.interrupt_start.add("trusted-media-v1")
            with self.assertRaises(KeyboardInterrupt):
                controller.start(transaction_id="restart-first")
            runtime.interrupt_start.clear()
            recovered = self.controller(root, runtime).initialize()
            self.assertEqual(recovered["active"]["releaseId"], "trusted-media-v1")
            self.assertFalse(recovered["activeRunning"])
            self.assertEqual(recovered["lastFailureCode"], "media_release_interrupted_rolled_back")
            self.assertIsNone(recovered["transaction"])
            self.assertNotIn(("remove", "trusted-media-v1"), runtime.events)

    def test_quiesce_attempts_state_clear_and_remove_after_prior_cleanup_failures(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = FakeRuntime()
            controller = self.controller(Path(directory), runtime)
            controller.initialize()
            first = release(1)
            controller.stage(first)
            controller.activate(transaction_id="install-first", trusted_media_image_digest=str(first["trustedMediaImageDigest"]))
            runtime.fail_operations.update({"withdraw", "stop"})
            with self.assertRaises(MediaReleaseError) as caught:
                controller.uninstall(transaction_id="uninstall-failing")
            self.assertEqual(caught.exception.code, "media_release_recovery_incomplete")
            self.assertIn(("clear", "trusted-media-v1"), runtime.events)
            self.assertIn(("remove", "trusted-media-v1"), runtime.events)
            state = controller.status()
            self.assertEqual(state["active"]["releaseId"], "trusted-media-v1")
            self.assertFalse(state["activeRunning"])
            self.assertTrue(state["degraded"])
            self.assertEqual(state["transaction"]["operation"], "uninstall")
            self.assertEqual(state["transaction"]["phase"], "recovery-required")
            runtime.fail_operations.clear()
            recovered = controller.recover()
            self.assertIsNone(recovered["active"])
            self.assertIsNone(recovered["transaction"])
            self.assertFalse(recovered["degraded"])
            self.assertEqual(recovered["lastFailureCode"], "media_release_interrupted_completed")

    def test_candidate_cleanup_failure_never_claims_a_successful_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = FakeRuntime()
            controller = self.controller(Path(directory), runtime)
            controller.initialize()
            first, second = release(1), release(2)
            controller.stage(first)
            controller.activate(transaction_id="install-first", trusted_media_image_digest=str(first["trustedMediaImageDigest"]))
            controller.stage(second)
            runtime.unhealthy.add("trusted-media-v2")
            runtime.fail_operations.add("remove")
            with self.assertRaises(MediaReleaseError) as caught:
                controller.upgrade(transaction_id="upgrade-cleanup-unknown", trusted_media_image_digest=str(second["trustedMediaImageDigest"]))
            self.assertEqual(caught.exception.code, "media_release_recovery_incomplete")
            state = controller.status()
            self.assertEqual(state["active"]["releaseId"], "trusted-media-v1")
            self.assertFalse(state["activeRunning"])
            self.assertTrue(state["degraded"])
            self.assertEqual(state["transaction"]["phase"], "recovery-required")
            runtime.fail_operations.clear()
            runtime.unhealthy.clear()
            recovered = controller.recover()
            self.assertEqual(recovered["active"]["releaseId"], "trusted-media-v1")
            self.assertTrue(recovered["activeRunning"])
            self.assertFalse(recovered["degraded"])
            self.assertIsNone(recovered["transaction"])

    def test_stop_cleanup_failure_retries_quiesce_and_finishes_stopped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = FakeRuntime()
            controller = self.controller(Path(directory), runtime)
            controller.initialize()
            first = release(1)
            controller.stage(first)
            controller.activate(transaction_id="install-first", trusted_media_image_digest=str(first["trustedMediaImageDigest"]))
            runtime.fail_operations.add("clear")
            with self.assertRaises(MediaReleaseError) as caught:
                controller.stop(transaction_id="stop-cleanup-unknown")
            self.assertEqual(caught.exception.code, "media_release_recovery_incomplete")
            state = controller.status()
            self.assertFalse(state["activeRunning"])
            self.assertTrue(state["degraded"])
            self.assertEqual(state["transaction"]["operation"], "stop")
            runtime.fail_operations.clear()
            recovered = controller.recover()
            self.assertEqual(recovered["active"]["releaseId"], "trusted-media-v1")
            self.assertFalse(recovered["activeRunning"])
            self.assertFalse(recovered["degraded"])
            self.assertEqual(recovered["lastFailureCode"], "media_release_interrupted_completed")

    def test_uninstall_attempts_every_owned_release_before_recovery_required(self) -> None:
        class ReleaseScopedFailureRuntime(FakeRuntime):
            def __init__(self) -> None:
                super().__init__()
                self.fail_remove_release: str | None = None

            def remove(self, value):
                identity = self.identity(value)
                self.events.append(("remove", identity))
                if identity == self.fail_remove_release:
                    raise RuntimeError("synthetic scoped removal failure")

        with tempfile.TemporaryDirectory() as directory:
            runtime = ReleaseScopedFailureRuntime()
            controller = self.controller(Path(directory), runtime)
            controller.initialize()
            first, second, third = release(1), release(2), release(3)
            controller.stage(first)
            controller.activate(transaction_id="install-first", trusted_media_image_digest=str(first["trustedMediaImageDigest"]))
            controller.stage(second)
            controller.upgrade(transaction_id="upgrade-second", trusted_media_image_digest=str(second["trustedMediaImageDigest"]))
            controller.stage(third)
            runtime.fail_remove_release = "trusted-media-v2"
            with self.assertRaises(MediaReleaseError) as caught:
                controller.uninstall(transaction_id="uninstall-three-releases")
            self.assertEqual(caught.exception.code, "media_release_recovery_incomplete")
            self.assertIn(("remove", "trusted-media-v2"), runtime.events)
            self.assertIn(("remove", "trusted-media-v1"), runtime.events)
            self.assertIn(("remove", "trusted-media-v3"), runtime.events)
            state = controller.status()
            self.assertTrue(state["degraded"])
            self.assertEqual(state["transaction"]["phase"], "recovery-required")
            runtime.fail_remove_release = None
            recovered = controller.recover()
            self.assertIsNone(recovered["active"])
            self.assertIsNone(recovered["previous"])
            self.assertIsNone(recovered["staged"])
            self.assertIsNone(recovered["transaction"])

    def test_failed_restore_recovery_quiesces_partial_restore_before_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = FakeRuntime()
            controller = self.controller(Path(directory), runtime)
            controller.initialize()
            first, second = release(1), release(2)
            controller.stage(first)
            controller.activate(transaction_id="install-first", trusted_media_image_digest=str(first["trustedMediaImageDigest"]))
            controller.stage(second)
            runtime.unhealthy.update({"trusted-media-v1", "trusted-media-v2"})
            with self.assertRaises(MediaReleaseError) as caught:
                controller.upgrade(transaction_id="upgrade-and-fail-restore", trusted_media_image_digest=str(second["trustedMediaImageDigest"]))
            self.assertEqual(caught.exception.code, "media_release_recovery_incomplete")
            runtime.unhealthy.clear()
            before = len(runtime.events)
            recovered = controller.recover()
            recovery_events = runtime.events[before:]
            self.assertEqual(recovered["active"]["releaseId"], "trusted-media-v1")
            self.assertTrue(recovered["activeRunning"])
            prior_cleanup = [
                ("withdraw", "trusted-media-v1"),
                ("stop", "trusted-media-v1"),
                ("clear", "trusted-media-v1"),
            ]
            start_index = recovery_events.index(("start", "trusted-media-v1"))
            self.assertEqual(recovery_events[start_index - 3:start_index], prior_cleanup)

    def test_release_state_rejects_secret_or_unpinned_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            controller = self.controller(Path(directory), FakeRuntime())
            controller.initialize()
            invalid = release(1)
            invalid["pin"] = "123456"
            with self.assertRaisesRegex(MediaReleaseError, "fields are not exact"):
                controller.stage(invalid)
            serialized = (Path(directory) / "release-state.json").read_text(encoding="utf-8")
            self.assertNotIn("123456", serialized)
            self.assertNotIn("pin", serialized.lower())
            self.assertNotIn("token", serialized.lower())

    def test_host_exception_guard_is_read_only_and_rejects_unknown_changes(self) -> None:
        policy = json.loads((ROOT / "deploy/casting/trusted-media-host-exceptions.v1.json").read_text(encoding="utf-8"))
        hardware = json.loads((ROOT / "evidence/validation/hardware/airplay-main-hardware-inventory-20260904-a1.json").read_text(encoding="utf-8"))
        result = evaluate_host_exceptions(
            policy,
            hardware,
            observed_services={"docker.service": "active"},
            unregistered_host_changes=("package:uxplay",),
        )
        self.assertFalse(result["conforming"])
        self.assertFalse(result["releaseEvidenceEligible"])
        self.assertFalse(result["mutationPerformed"])
        self.assertIn("unregistered:package:uxplay", {item["key"] for item in result["drifts"]})

    def test_rootfs_manifest_requires_real_arm64_elf_and_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            elf = bytearray(64)
            elf[:4] = b"\x7fELF"
            elf[4] = 2
            elf[5] = 1
            elf[6] = 1
            elf[18:20] = (183).to_bytes(2, "little")
            for relative in REQUIRED_EXECUTABLES:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(elf + relative.encode("utf-8"))
                path.chmod(0o755)
            first = create_manifest(root, source_lock_digest="sha256:" + "a" * 64)
            second = create_manifest(root, source_lock_digest="sha256:" + "a" * 64)
            self.assertEqual(first, second)
            self.assertEqual(first["architecture"], "linux/arm64/v8")
            self.assertFalse(first["claimBoundary"]["imageBuilt"])
            with self.assertRaisesRegex(ValueError, "source lock digest"):
                create_manifest(root, source_lock_digest="sha256:" + "G" * 64)
            (root / REQUIRED_EXECUTABLES[0]).write_text("not an ELF", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "not ELF"):
                create_manifest(root, source_lock_digest="sha256:" + "a" * 64)


if __name__ == "__main__":
    unittest.main()
