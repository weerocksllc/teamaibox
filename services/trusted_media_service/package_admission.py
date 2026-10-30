"""Digest-bound admission gate for a trusted media release descriptor."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Mapping


def file_digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


class PackageAdmissionGate:
    """Re-evaluate every immutable and human/hardware gate before lifecycle work."""

    def __init__(self, *, repository_root: Path, package_path: Path) -> None:
        self._root = Path(repository_root).resolve()
        self._package_path = Path(package_path).resolve()
        if not self._package_path.is_relative_to(self._root):
            raise ValueError("package path must be inside the repository")

    def __call__(self, release: Mapping[str, object]) -> tuple[str, ...]:
        blockers: set[str] = set()
        package = self._load(self._package_path)
        if package.get("schemaVersion") == 2:
            return self._call_v2(package, release)
        for section_name in ("sourceLock", "supplyChainReview", "hardwareInventory"):
            section = package.get(section_name, {})
            path = self._local_path(section.get("path"))
            expected = section.get("sha256") or section.get("fileSha256")
            if path is None or not path.is_file() or file_digest(path) != expected:
                blockers.add(f"{section_name}_digest_mismatch")

        lock = self._load_from(package.get("sourceLock", {}).get("path"))
        review = self._load_from(package.get("supplyChainReview", {}).get("path"))
        hardware = self._load_from(package.get("hardwareInventory", {}).get("path"))
        if lock.get("target", {}).get("releaseEligible") is not True:
            blockers.add("source_lock_not_release_eligible")
        if review.get("decision", {}).get("releaseEligible") is not True:
            blockers.add("airplay_supply_chain_human_decisions_pending")
        inventory = hardware.get("inventory", {})
        if inventory.get("decision", {}).get("supportedEnvironment") is not True:
            blockers.update(inventory.get("decision", {}).get("reasonCodes", []))
        display = inventory.get("display", {})
        audio = inventory.get("audio", {})
        gstreamer = inventory.get("gstreamer", {})
        discovery = inventory.get("discovery", {})
        gpu = inventory.get("gpu", {})
        if display.get("hdmiConnectorPresent") is not True:
            blockers.add("hdmi_connector_missing")
        if display.get("hdmiConnected") is not True:
            blockers.add("hdmi_sink_disconnected")
        if display.get("baseline1080p30Proven") is not True:
            blockers.add("hdmi_1080p30_not_proven")
        if audio.get("hdmiAudioSinkProven") is not True:
            blockers.add("hdmi_audio_sink_not_proven")
        if gstreamer.get("h264EncoderPresent") is not True:
            blockers.add("h264_encoder_plugin_missing")
        if gstreamer.get("plugins", {}).get("webrtcbin") is not True:
            blockers.add("webrtc_plugin_missing")
        if not (
            discovery.get("avahiActive") is True
            and discovery.get("mdnsPort") == 5353
            and discovery.get("sameLayer2Required") is True
        ):
            blockers.add("same_l2_mdns_prerequisite_missing")
        if gpu.get("containerDeviceExposurePossible") is not True:
            blockers.add("nvidia_video_device_exposure_unavailable")

        build = package.get("build", {})
        if build.get("buildPerformed") is not True:
            blockers.add("trusted_media_arm64_image_unbuilt")
        if build.get("reproducible") is not True or len(build.get("twoIndependentBuildDigests", [])) != 2:
            blockers.add("trusted_media_reproducible_build_missing")
        if not build.get("rootfsManifestSha256"):
            blockers.add("trusted_media_rootfs_manifest_missing")

        image = package.get("images", {}).get("trustedMediaService", {})
        for key, code in {
            "arm64Digest": "trusted_media_arm64_image_digest_missing",
            "signatureVerified": "trusted_media_image_signature_missing",
            "provenanceVerified": "trusted_media_image_provenance_missing",
            "spdxSbomVerified": "trusted_media_spdx_sbom_missing",
            "cycloneDxSbomVerified": "trusted_media_cyclonedx_sbom_missing",
            "vulnerabilitiesAccepted": "trusted_media_vulnerability_acceptance_missing",
        }.items():
            expected = True if key != "arm64Digest" else release.get("trustedMediaImageDigest")
            if image.get(key) != expected:
                blockers.add(code)

        expected_bindings = {
            "sourceLockDigest": package.get("sourceLock", {}).get("sha256"),
            "hardwareEvidenceDigest": package.get("hardwareInventory", {}).get("evidenceDigest"),
            "runtimePolicyDigest": package.get("policies", {}).get("runtime", {}).get("sha256"),
            "rootfsManifestDigest": build.get("rootfsManifestSha256"),
            "trustedMediaImageDigest": image.get("arm64Digest"),
            "sfuImageDigest": package.get("images", {}).get("internalSfu", {}).get("arm64Digest"),
        }
        for key, expected in expected_bindings.items():
            if release.get(key) != expected:
                blockers.add(f"release_binding_mismatch:{key}")

        for name, reference in package.get("policies", {}).items():
            path = self._local_path(reference.get("path"))
            if path is None or not path.is_file() or file_digest(path) != reference.get("sha256"):
                blockers.add(f"policy_digest_mismatch:{name}")

        if release.get("releaseEligible") is not True or release.get("hardwareSupported") is not True:
            blockers.add("release_descriptor_not_eligible")
        return tuple(sorted(blockers))

    def _call_v2(
        self,
        package: Mapping[str, object],
        release: Mapping[str, object],
    ) -> tuple[str, ...]:
        """Apply the simplified open-source release gate plus activation gates.

        Supply-chain qualification and hardware activation are deliberately
        separate: passing OpenSpec 22.1 never starts or advertises a receiver.
        """

        blockers: set[str] = set()
        for section_name in (
            "sourceLock",
            "supplyChainReview",
            "releaseMinimumEvidence",
            "hardwareInventory",
        ):
            section = package.get(section_name, {})
            if not isinstance(section, Mapping):
                blockers.add(f"{section_name}_digest_mismatch")
                continue
            path = self._local_path(section.get("path"))
            expected = section.get("sha256") or section.get("fileSha256")
            if path is None or not path.is_file() or file_digest(path) != expected:
                blockers.add(f"{section_name}_digest_mismatch")

        review = self._load_from(package.get("supplyChainReview", {}).get("path"))
        decision = review.get("decision", {})
        inherited = review.get("humanDecisionInheritance", {})
        if not (
            decision.get("allRequiredHumanDecisionsApproved") is True
            and inherited.get("approved") == 5
            and inherited.get("pending") == 0
        ):
            blockers.add("airplay_supply_chain_human_decisions_pending")

        qualification = self._load_from(package.get("releaseMinimumEvidence", {}).get("path"))
        qualification_ref = package.get("releaseMinimumEvidence", {})
        unsigned = dict(qualification)
        recorded_digest = unsigned.pop("evidenceDigest", None)
        canonical = "sha256:" + hashlib.sha256(
            json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        if not (
            qualification.get("status") == "passed"
            and recorded_digest == canonical == qualification_ref.get("evidenceDigest")
            and qualification.get("claimBoundary", {}).get("task22_1Complete") is True
            and qualification.get("spdx", {}).get("verified") is True
            and qualification.get("vulnerabilities", {}).get("unacceptedCriticalCount") == 0
            and qualification.get("signature", {}).get("verified") is True
            and qualification.get("signature", {}).get("privateKeyRetained") is False
        ):
            blockers.add("open_source_release_minimum_not_verified")

        build = package.get("build", {})
        if build.get("buildPerformed") is not True or build.get("independentBuildCount") != 1:
            blockers.add("trusted_media_arm64_image_unbuilt")
        if build.get("reproducibleBuildRequired") is not False:
            blockers.add("open_source_release_scope_drifted")
        image = package.get("images", {}).get("trustedMediaService", {})
        if not image.get("arm64Digest"):
            blockers.add("trusted_media_arm64_image_digest_missing")
        if image.get("signatureVerified") is not True:
            blockers.add("trusted_media_image_signature_missing")
        if image.get("spdxSbomVerified") is not True:
            blockers.add("trusted_media_spdx_sbom_missing")
        if image.get("vulnerabilitiesAccepted") is not True or image.get("unacceptedCriticalCount") != 0:
            blockers.add("trusted_media_vulnerability_acceptance_missing")
        if image.get("provenanceRequired") is not False or image.get("cycloneDxRequired") is not False:
            blockers.add("open_source_release_scope_drifted")

        for group_name in ("releaseArtifacts", "policies"):
            group = package.get(group_name, {})
            if not isinstance(group, Mapping):
                blockers.add(f"{group_name}_missing")
                continue
            for name, reference in group.items():
                path = self._local_path(reference.get("path"))
                if path is None or not path.is_file() or file_digest(path) != reference.get("sha256"):
                    blockers.add(f"{group_name}_digest_mismatch:{name}")
        for name in ("dockerfile", "instructions"):
            reference = build.get(name, {})
            path = self._local_path(reference.get("path"))
            if path is None or not path.is_file() or file_digest(path) != reference.get("sha256"):
                blockers.add(f"build_artifact_digest_mismatch:{name}")

        hardware = self._load_from(package.get("hardwareInventory", {}).get("path"))
        inventory = hardware.get("inventory", {})
        if inventory.get("decision", {}).get("supportedEnvironment") is not True:
            blockers.update(inventory.get("decision", {}).get("reasonCodes", []))
            blockers.add("hardware_supported_environment_not_yet_proven")
        display = inventory.get("display", {})
        audio = inventory.get("audio", {})
        if display.get("hdmiConnected") is not True:
            blockers.add("hdmi_sink_disconnected")
        if display.get("baseline1080p30Proven") is not True:
            blockers.add("hdmi_1080p30_not_proven")
        if audio.get("hdmiAudioSinkProven") is not True:
            blockers.add("hdmi_audio_sink_not_proven")

        expected_bindings = {
            "sourceLockDigest": package.get("sourceLock", {}).get("sha256"),
            "hardwareEvidenceDigest": package.get("hardwareInventory", {}).get("evidenceDigest"),
            "runtimePolicyDigest": package.get("policies", {}).get("runtime", {}).get("sha256"),
            "trustedMediaImageDigest": image.get("arm64Digest"),
            "sfuImageDigest": package.get("images", {}).get("internalSfu", {}).get("arm64Digest"),
            "openSourceReleaseEvidenceDigest": qualification_ref.get("evidenceDigest"),
        }
        for key, expected in expected_bindings.items():
            if release.get(key) != expected:
                blockers.add(f"release_binding_mismatch:{key}")
        if release.get("releaseEligible") is not True or release.get("hardwareSupported") is not True:
            blockers.add("release_descriptor_not_eligible")
        return tuple(sorted(blockers))

    def _load_from(self, relative: object) -> dict[str, object]:
        path = self._local_path(relative)
        return self._load(path) if path is not None and path.is_file() else {}

    def _local_path(self, relative: object) -> Path | None:
        if not isinstance(relative, str) or relative.startswith("/") or ".." in Path(relative).parts:
            return None
        path = (self._root / relative).resolve()
        return path if path.is_relative_to(self._root) else None

    @staticmethod
    def _load(path: Path) -> dict[str, object]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return value if isinstance(value, dict) else {}
