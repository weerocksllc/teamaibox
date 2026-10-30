from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from services.trusted_media_service import runtime_orchestrator as orchestrator

from services.trusted_media_service.package_admission import PackageAdmissionGate
from services.trusted_media_service.release_controller import MediaReleaseController, MediaReleaseError
from services.trusted_media_service.runtime_orchestrator import (
    ROOT,
    TrustedMediaContractError,
    TrustedMediaRuntimeOrchestrator,
    canonical_digest,
    materialize_release_set,
    validate_component_template,
    validate_health_snapshot,
)


TEMPLATE_PATH = ROOT / "deploy/casting/trusted-media-release-set.template.v1.json"


def release(number: int) -> dict[str, object]:
    package = json.loads((ROOT / "deploy/casting/trusted-media-service.package.v1.json").read_text(encoding="utf-8"))
    return {
        "releaseId": f"trusted-media-v{number}",
        "architecture": "linux/arm64/v8",
        "trustedMediaImageDigest": "sha256:" + str(number) * 64,
        "sfuImageDigest": package["images"]["internalSfu"]["arm64Digest"],
        "runtimePolicyDigest": package["policies"]["runtime"]["sha256"],
        "sourceLockDigest": package["sourceLock"]["sha256"],
        "hardwareEvidenceDigest": package["hardwareInventory"]["evidenceDigest"],
        "rootfsManifestDigest": "sha256:" + chr(ord("d") + number) * 64,
        "releaseEligible": True,
        "hardwareSupported": True,
        "healthTimeoutSeconds": 30,
    }


def build_evidence(value: dict[str, object]) -> dict[str, object]:
    template = json.loads(TEMPLATE_PATH.read_text(encoding="utf-8"))
    return {
        "rootfsManifestDigest": value["rootfsManifestDigest"],
        "twoIndependentBuildDigests": [
            value["trustedMediaImageDigest"],
            value["trustedMediaImageDigest"],
        ],
        "observedGstreamerElements": template["buildContract"]["requiredGstreamerElements"],
        "observedForbiddenGstreamerElements": [],
    }


def materialize(value: dict[str, object]) -> dict[str, object]:
    return materialize_release_set(
        value,
        build_evidence(value),
        approved_lan_address="10.64.0.20",
        sfu_user="10001:10001",
        selected_hdmi_playback="/dev/snd/pcmC0D3p",
        admission_check=lambda _release: (),
    )


def health_snapshot(
    value: dict[str, object],
    manifest: dict[str, object],
    *,
    phase: str = "idle",
    selected_sinks: list[str] | None = None,
) -> dict[str, object]:
    selected = list(selected_sinks or [])
    browser = "browser" in selected
    return {
        "schemaVersion": 1,
        "releaseId": value["releaseId"],
        "trustedMediaImageDigest": value["trustedMediaImageDigest"],
        "sfuImageDigest": value["sfuImageDigest"],
        "phase": phase,
        "supervisorReady": True,
        "sfuReady": True,
        "serviceReservationProfileDigest": canonical_digest(manifest["reservation"]),
        "serviceReservationActive": True,
        "sessionReservationProfileDigest": canonical_digest(manifest["sessionReservation"]),
        "sessionReservationActive": phase == "active",
        "receiverRunning": phase == "active",
        "mdnsAdvertised": phase == "active",
        "selectedSinks": selected,
        "sinkHealth": {
            "hdmi": "ready" if "hdmi" in selected else "not-selected",
            "browser": "ready" if browser else "not-selected",
        },
        "publisherEncodeRenditions": 1 if phase == "active" and browser else 0,
        "viewerCount": 1 if phase == "active" and browser else 0,
        "ephemeralStateOnTmpfs": True,
    }


class FakeNarrowNodeAgent:
    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []
        self.manifests: dict[str, dict[str, object]] = {}
        self.unhealthy: set[str] = set()
        self.fail_sfu_start: set[str] = set()
        self.fail_remove_media: set[str] = set()

    @staticmethod
    def identity(value: dict[str, object]) -> str:
        return str(value["releaseId"])

    def acquire_reservation(self, value, reservation):
        self.events.append(("reserve", self.identity(value)))

    def start_sfu(self, value, service):
        identity = self.identity(value)
        self.events.append(("start-sfu", identity))
        if identity in self.fail_sfu_start:
            raise RuntimeError("synthetic SFU start failure")

    def start_trusted_media(self, value, service):
        self.events.append(("start-media", self.identity(value)))

    def wait_release_set_health(self, value, timeout_seconds):
        identity = self.identity(value)
        self.events.append((f"health:{timeout_seconds}", identity))
        snapshot = health_snapshot(value, self.manifests[identity])
        if identity in self.unhealthy:
            snapshot["supervisorReady"] = False
        return snapshot

    def withdraw_discovery(self, value):
        self.events.append(("withdraw", self.identity(value)))

    def stop_trusted_media(self, value):
        self.events.append(("stop-media", self.identity(value)))

    def stop_sfu(self, value):
        self.events.append(("stop-sfu", self.identity(value)))

    def clear_ephemeral_state(self, value):
        self.events.append(("clear", self.identity(value)))

    def release_reservation(self, value, reservation):
        self.events.append(("release", self.identity(value)))

    def remove_trusted_media(self, value):
        identity = self.identity(value)
        self.events.append(("remove-media", identity))
        if identity in self.fail_remove_media:
            raise RuntimeError("synthetic media removal failure")

    def remove_sfu(self, value):
        self.events.append(("remove-sfu", self.identity(value)))


class TrustedMediaRuntimeComponentTest(unittest.TestCase):
    def setUp(self):
        # Retain the old HDMI-era orchestration contract as a unit fixture.
        # The live browser-only service is tested in its separate runtime suite.
        original_load = orchestrator._load
        fixture = original_load(TEMPLATE_PATH)
        for reference in fixture['bindings'].values():
            reference['sha256'] = orchestrator.file_digest(ROOT/reference['path'])
        def load_fixture(path):
            return copy.deepcopy(fixture) if path == TEMPLATE_PATH else original_load(path)
        patcher = mock.patch.object(orchestrator, '_load', side_effect=load_fixture)
        patcher.start(); self.addCleanup(patcher.stop)
        self.template_fixture = fixture

    def validate_mutation(self, mutate) -> None:
        value = copy.deepcopy(self.template_fixture)
        mutate(value)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            validate_component_template(path)

    def test_legacy_template_contract_is_intentionally_blocked(self) -> None:
        result = validate_component_template()
        self.assertTrue(result["valid"])
        self.assertTrue(result["componentContractReady"])
        self.assertFalse(result["materialized"])
        self.assertFalse(result["componentReady"])
        self.assertFalse(result["releaseEligible"])
        self.assertFalse(result["task22_3Complete"])
        self.assertEqual(result["requiredExecutableCount"], 5)
        self.assertEqual(result["requiredGstreamerElementCount"], 17)
        self.assertEqual(result["deviceCount"], 7)

    def test_static_validator_rejects_capability_device_plugin_and_claim_expansion(self) -> None:
        mutations = (
            (lambda value: value["services"]["trustedMedia"]["security"]["capAdd"].append("SYS_ADMIN"), "capabilities expanded"),
            (lambda value: value["services"]["trustedMedia"]["deviceAllowlist"].append({"path": "/dev", "access": "rwm"}), "device set drifted"),
            (lambda value: value["services"]["trustedMedia"]["nvidia"]["driverCapabilities"].append("compute"), "NVIDIA driver capabilities drifted"),
            (lambda value: value["mediaContract"]["browserViewerAuthorization"].update({"tokenTtlSeconds": 300}), "viewer authorization contract drifted"),
            (lambda value: value["officialApplicationPluginBoundary"].update({"networkMode": "host"}), "plugin gained a runtime network"),
            (lambda value: value["claimBoundary"].update({"task22_3Complete": True}), "overclaims task22_3Complete"),
        )
        for mutate, message in mutations:
            with self.subTest(message=message), self.assertRaisesRegex(TrustedMediaContractError, message):
                self.validate_mutation(mutate)

    def test_current_package_cannot_materialize_around_legal_hardware_or_build_gates(self) -> None:
        value = release(1)
        gate = PackageAdmissionGate(
            repository_root=ROOT,
            package_path=ROOT / "deploy/casting/trusted-media-service.package.v1.json",
        )
        with self.assertRaisesRegex(TrustedMediaContractError, "release admission is blocked") as caught:
            materialize_release_set(
                value,
                build_evidence(value),
                approved_lan_address="10.64.0.20",
                sfu_user="10001:10001",
                selected_hdmi_playback="/dev/snd/pcmC0D3p",
                admission_check=gate,
            )
        message = str(caught.exception)
        self.assertIn("airplay_supply_chain_human_decisions_pending", message)
        self.assertIn("hdmi_sink_disconnected", message)
        self.assertIn("trusted_media_arm64_image_unbuilt", message)

    def test_materialization_requires_reproducible_build_elements_private_lan_and_nonroot_sfu(self) -> None:
        value = release(1)
        evidence = build_evidence(value)
        evidence["twoIndependentBuildDigests"][1] = "sha256:" + "9" * 64
        with self.assertRaisesRegex(TrustedMediaContractError, "not reproducible"):
            materialize_release_set(
                value,
                evidence,
                approved_lan_address="10.64.0.20",
                sfu_user="10001:10001",
                selected_hdmi_playback="/dev/snd/pcmC0D3p",
                admission_check=lambda _release: (),
            )
        evidence = build_evidence(value)
        evidence["observedGstreamerElements"] = evidence["observedGstreamerElements"][:-1]
        with self.assertRaisesRegex(TrustedMediaContractError, "inspection is incomplete"):
            materialize_release_set(
                value,
                evidence,
                approved_lan_address="10.64.0.20",
                sfu_user="10001:10001",
                selected_hdmi_playback="/dev/snd/pcmC0D3p",
                admission_check=lambda _release: (),
            )
        for address in ("127.0.0.1", "0.0.0.0", "8.8.8.8"):
            with self.subTest(address=address), self.assertRaisesRegex(TrustedMediaContractError, "same-L2"):
                materialize_release_set(
                    value,
                    build_evidence(value),
                    approved_lan_address=address,
                    sfu_user="10001:10001",
                    selected_hdmi_playback="/dev/snd/pcmC0D3p",
                    admission_check=lambda _release: (),
                )
        with self.assertRaisesRegex(TrustedMediaContractError, "non-root"):
            materialize_release_set(
                value,
                build_evidence(value),
                approved_lan_address="10.64.0.20",
                sfu_user="0:0",
                selected_hdmi_playback="/dev/snd/pcmC0D3p",
                admission_check=lambda _release: (),
            )
        with self.assertRaisesRegex(TrustedMediaContractError, "outside the reviewed allowlist"):
            materialize_release_set(
                value,
                build_evidence(value),
                approved_lan_address="10.64.0.20",
                sfu_user="10001:10001",
                selected_hdmi_playback="/dev/snd/pcmC0D0c",
                admission_check=lambda _release: (),
            )
        result = materialize(value)
        self.assertEqual(result["status"], "materialized-candidate")
        self.assertEqual(result["services"]["trustedMedia"]["imageDigest"], value["trustedMediaImageDigest"])
        self.assertEqual(result["services"]["internalSfu"]["user"], "10001:10001")
        self.assertEqual(result["services"]["internalSfu"]["network"]["control"]["hostAddress"], "127.0.0.1")
        self.assertEqual(result["services"]["internalSfu"]["network"]["rtcUdp"]["hostAddress"], "10.64.0.20")
        self.assertEqual(
            [item["path"] for item in result["services"]["trustedMedia"]["devices"]],
            ["/dev/dri/card0", "/dev/dri/renderD128", "/dev/snd/controlC0", "/dev/snd/pcmC0D3p"],
        )
        self.assertEqual(result["activationGate"], {"materialized": True, "currentBlockers": []})
        self.assertFalse(result["claimBoundary"]["task22_3Complete"])

        drifted = release(1)
        drifted["sourceLockDigest"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(TrustedMediaContractError, "source lock digest drifted"):
            materialize_release_set(
                drifted,
                build_evidence(drifted),
                approved_lan_address="10.64.0.20",
                sfu_user="10001:10001",
                selected_hdmi_playback="/dev/snd/pcmC0D3p",
                admission_check=lambda _release: (),
            )

    def test_health_contract_accepts_idle_and_active_but_rejects_stale_media_or_secrets(self) -> None:
        value = release(1)
        manifest = materialize(value)
        idle = health_snapshot(value, manifest)
        self.assertEqual(validate_health_snapshot(idle, release=value, manifest=manifest)["phase"], "idle")
        active = health_snapshot(value, manifest, phase="active", selected_sinks=["hdmi", "browser"])
        self.assertEqual(validate_health_snapshot(active, release=value, manifest=manifest)["selectedSinks"], ["hdmi", "browser"])

        advertised_idle = copy.deepcopy(idle)
        advertised_idle["mdnsAdvertised"] = True
        with self.assertRaisesRegex(TrustedMediaContractError, "idle service is receiving or advertising"):
            validate_health_snapshot(advertised_idle, release=value, manifest=manifest)
        reserved_idle = copy.deepcopy(idle)
        reserved_idle["sessionReservationActive"] = True
        with self.assertRaisesRegex(TrustedMediaContractError, "idle service retains a media session reservation"):
            validate_health_snapshot(reserved_idle, release=value, manifest=manifest)
        unreserved_active = copy.deepcopy(active)
        unreserved_active["sessionReservationActive"] = False
        with self.assertRaisesRegex(TrustedMediaContractError, "active receiver has no media session reservation"):
            validate_health_snapshot(unreserved_active, release=value, manifest=manifest)
        per_viewer_encode = copy.deepcopy(active)
        per_viewer_encode["publisherEncodeRenditions"] = 2
        with self.assertRaisesRegex(TrustedMediaContractError, "one publisher rendition"):
            validate_health_snapshot(per_viewer_encode, release=value, manifest=manifest)
        more_viewers = copy.deepcopy(active)
        more_viewers["viewerCount"] = 9
        self.assertEqual(validate_health_snapshot(more_viewers, release=value, manifest=manifest)['viewerCount'], 9)
        over_capacity = copy.deepcopy(active)
        over_capacity["viewerCount"] = -1
        with self.assertRaisesRegex(TrustedMediaContractError, "viewer count"):
            validate_health_snapshot(over_capacity, release=value, manifest=manifest)
        secret = copy.deepcopy(active)
        secret["sinkHealth"]["pairingPin"] = "1234"
        with self.assertRaisesRegex(TrustedMediaContractError, "secret or media field"):
            validate_health_snapshot(secret, release=value, manifest=manifest)

    def test_narrow_runtime_reserves_before_start_and_failed_health_restores_previous(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            node = FakeNarrowNodeAgent()

            def factory(value):
                result = materialize(value)
                node.manifests[str(value["releaseId"])] = result
                return result

            runtime = TrustedMediaRuntimeOrchestrator(node_agent=node, manifest_factory=factory)
            controller = MediaReleaseController(
                state_directory=Path(directory),
                runtime=runtime,
                admission_check=lambda _release: (),
            )
            controller.initialize()
            first, second = release(1), release(2)
            controller.stage(first)
            controller.activate(transaction_id="install-first", trusted_media_image_digest=str(first["trustedMediaImageDigest"]))
            self.assertEqual(node.events[:4], [
                ("reserve", "trusted-media-v1"),
                ("start-sfu", "trusted-media-v1"),
                ("start-media", "trusted-media-v1"),
                ("health:30", "trusted-media-v1"),
            ])

            node.unhealthy.add("trusted-media-v2")
            controller.stage(second)
            with self.assertRaises(MediaReleaseError) as caught:
                controller.upgrade(transaction_id="upgrade-bad", trusted_media_image_digest=str(second["trustedMediaImageDigest"]))
            self.assertEqual(caught.exception.code, "media_release_activation_failed")
            state = controller.status()
            self.assertEqual(state["active"]["releaseId"], "trusted-media-v1")
            self.assertTrue(state["activeRunning"])
            self.assertFalse(state["degraded"])

            upgrade_events = node.events[4:]
            expected_order = [
                ("withdraw", "trusted-media-v1"),
                ("stop-media", "trusted-media-v1"),
                ("stop-sfu", "trusted-media-v1"),
                ("clear", "trusted-media-v1"),
                ("release", "trusted-media-v1"),
                ("reserve", "trusted-media-v2"),
                ("start-sfu", "trusted-media-v2"),
                ("start-media", "trusted-media-v2"),
                ("health:30", "trusted-media-v2"),
            ]
            self.assertEqual(upgrade_events[: len(expected_order)], expected_order)
            self.assertIn(("remove-media", "trusted-media-v2"), upgrade_events)
            self.assertIn(("remove-sfu", "trusted-media-v2"), upgrade_events)
            self.assertEqual(upgrade_events[-4:], [
                ("reserve", "trusted-media-v1"),
                ("start-sfu", "trusted-media-v1"),
                ("start-media", "trusted-media-v1"),
                ("health:30", "trusted-media-v1"),
            ])

    def test_partial_start_releases_exact_reservation_without_starting_media(self) -> None:
        value = release(1)
        node = FakeNarrowNodeAgent()
        manifest = materialize(value)
        node.manifests[str(value["releaseId"])] = manifest
        node.fail_sfu_start.add(str(value["releaseId"]))
        runtime = TrustedMediaRuntimeOrchestrator(node_agent=node, manifest_factory=lambda _release: manifest)
        with self.assertRaisesRegex(RuntimeError, "SFU start failure"):
            runtime.start(value)
        self.assertEqual(node.events, [
            ("reserve", "trusted-media-v1"),
            ("start-sfu", "trusted-media-v1"),
            ("stop-sfu", "trusted-media-v1"),
            ("clear", "trusted-media-v1"),
            ("release", "trusted-media-v1"),
        ])

    def test_remove_attempts_both_containers_and_exact_release_identity_is_not_reused(self) -> None:
        first = release(1)
        second = dict(first)
        second["releaseId"] = "trusted-media-v1-repacked"
        node = FakeNarrowNodeAgent()

        def factory(value):
            result = materialize(value)
            node.manifests[str(value["releaseId"])] = result
            return result

        runtime = TrustedMediaRuntimeOrchestrator(node_agent=node, manifest_factory=factory)
        runtime.start(first)
        runtime.start(second)
        self.assertEqual(
            [event for event in node.events if event[0] == "reserve"],
            [("reserve", "trusted-media-v1"), ("reserve", "trusted-media-v1-repacked")],
        )
        node.fail_remove_media.add("trusted-media-v1")
        with self.assertRaisesRegex(RuntimeError, "media removal failure"):
            runtime.remove(first)
        self.assertIn(("remove-media", "trusted-media-v1"), node.events)
        self.assertIn(("remove-sfu", "trusted-media-v1"), node.events)


if __name__ == "__main__":
    unittest.main()
