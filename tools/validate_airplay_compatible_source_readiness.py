#!/usr/bin/env python3
"""Independently validate AirPlay-compatible source-only readiness evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping

try:
    from .run_airplay_compatible_source_readiness import (
        EVIDENCE_ROOT,
        HUMAN_DECISIONS,
        ROOT,
        RUN_ID,
        canonical_digest,
        file_digest,
        readiness_checks,
    )
except ImportError:
    from run_airplay_compatible_source_readiness import (
        EVIDENCE_ROOT,
        HUMAN_DECISIONS,
        ROOT,
        RUN_ID,
        canonical_digest,
        file_digest,
        readiness_checks,
    )


SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
EXPECTED_SOURCE_PATHS = {
    "architecture/validation/airplay-compatible-supply-chain-review.v1.json",
    "architecture/validation/airplay-compatible-supply-chain-review.v2.json",
    "apps/platform-api/src/casting/trusted-media-runtime-client.mjs",
    "apps/platform-api/test/trusted-media-runtime-client.test.mjs",
    "apps/platform-api/server/trusted-media-runtime.mjs",
    "apps/platform-api/test/trusted-media-runtime-config.test.mjs",
    "deploy/casting/TrustedMediaService.arm64.Dockerfile",
    "deploy/casting/airplay-compatible-stack.lock.json",
    "deploy/casting/trusted-media-host-exceptions.v1.json",
    "deploy/casting/trusted-media-release-set.template.v1.json",
    "deploy/casting/trusted-media-runtime-policy.v1.json",
    "deploy/casting/trusted-media-seccomp.v1.json",
    "deploy/casting/trusted-media-service.package.v1.json",
    "deploy/legal/airplay-compatible/NOTICE.template.txt",
    "docs/operations/airplay-compatible-supply-chain-review.md",
    "docs/operations/airplay-compatible-human-approval.v2.md",
    "docs/operations/wireless-casting-guide.md",
    "evidence/validation/hardware/airplay-main-hardware-inventory-20260904-a1.json",
    "services/trusted_media_service/host_exception_guard.py",
    "services/trusted_media_service/package_admission.py",
    "services/trusted_media_service/release_controller.py",
    "services/trusted_media_service/runtime_orchestrator.py",
    "services/trusted_media_service/runtime_api.py",
    "services/trusted_media_service/viewer_token_issuer.py",
    "tests/test_airplay_compatible_source_readiness.py",
    "tests/test_airplay_compatible_supply_chain_review.py",
    "tests/test_trusted_media_service_scaffold.py",
    "tests/test_trusted_media_runtime_component.py",
    "tests/test_trusted_media_runtime_api.py",
    "tests/test_trusted_media_viewer_token_issuer.py",
    "tools/create_trusted_media_rootfs_manifest.py",
    "tools/run_airplay_compatible_source_readiness.py",
    "tools/validate_airplay_compatible_source_readiness.py",
    "tools/validate_airplay_compatible_supply_chain_review.py",
    "tools/validate_trusted_media_service_scaffold.py",
    "tools/validate_trusted_media_runtime_component.py",
}
EXPECTED_PINS = {
    "receiver": "UxPlay 1.73.6 @ 21eef8df25d91e12635c36d8176ad192725baca2",
    "mediaFramework": "GStreamer 1.28.6 @ 2d3e05cbdad68e47d645f548899b432dc9fb4473",
    "browserPublisher": "gst-plugin-webrtc 0.15.3 @ 75e46c3a1b868e9a08fd688d091476b76a498df1",
    "internalSfu": "LiveKit Server 1.13.6 @ 3cfbd1242618a61178f7a05b126d6c0c4cac3731",
    "browserViewer": "LiveKit browser client 2.21.0 @ 15ca5f8180ab8939c3a5a4dfee1d5e44f62f71cf",
}
EXPECTED_FALSE_VERIFICATION = {
    "completeTransitiveSbomVerified",
    "sourceArchiveDigestsVerified",
    "sourceSignaturesVerified",
    "finalArm64ImageBuilt",
    "finalArm64ImageDigestPinned",
    "finalImageSpdxVerified",
    "finalImageCycloneDxVerified",
    "finalImageSignatureVerified",
    "finalImageProvenanceVerified",
    "freshVulnerabilityEvidenceAccepted",
    "twoBuildReproducibilityVerified",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("source-readiness evidence cannot be read") from error
    require(isinstance(value, dict), "source-readiness evidence is not an object")
    return value


def validate(path: Path, *, revalidate: bool = True) -> dict[str, Any]:
    resolved = path.resolve()
    require(
        resolved.is_file()
        and resolved.parent == EVIDENCE_ROOT.resolve()
        and resolved.is_relative_to(ROOT),
        "source-readiness evidence path is invalid",
    )
    value = load(resolved)
    recorded_digest = value.get("evidenceDigest")
    unsigned = dict(value)
    unsigned.pop("evidenceDigest", None)
    require(
        isinstance(recorded_digest, str)
        and SHA256.fullmatch(recorded_digest) is not None
        and recorded_digest == canonical_digest(unsigned),
        "source-readiness evidence digest drifted",
    )
    run_id = value.get("runId")
    require(
        value.get("schemaVersion") == 1
        and value.get("runnerId") == "teamaibox.airplay-compatible-source-readiness.v1"
        and isinstance(run_id, str)
        and RUN_ID.fullmatch(run_id) is not None
        and resolved.name == run_id + ".json"
        and value.get("status") == "passed",
        "source-readiness evidence identity is invalid",
    )

    target = value.get("target")
    require(target == {
        "architecture": "linux/arm64/v8",
        "phase": "source-component-fail-closed",
        "remoteDeploymentPerformed": False,
        "liveStateObserved": False,
    }, "source-readiness target or execution phase drifted")

    records = value.get("sources")
    require(isinstance(records, list) and len(records) == len(EXPECTED_SOURCE_PATHS), "source binding count drifted")
    source_map: dict[str, str] = {}
    for record in records:
        require(isinstance(record, Mapping) and set(record) == {"path", "sha256"}, "source binding shape drifted")
        relative, digest = record.get("path"), record.get("sha256")
        require(isinstance(relative, str) and relative not in source_map, "source binding is missing or duplicated")
        require(not relative.startswith("/") and ".." not in Path(relative).parts, "source binding path is unsafe")
        candidate = (ROOT / relative).resolve()
        require(candidate.is_relative_to(ROOT) and candidate.is_file(), f"bound source is missing: {relative}")
        require(isinstance(digest, str) and SHA256.fullmatch(digest) is not None, f"source digest is invalid: {relative}")
        require(file_digest(candidate) == digest, f"bound source drifted: {relative}")
        source_map[relative] = digest
    require(set(source_map) == EXPECTED_SOURCE_PATHS, "exact source binding set drifted")

    require(value.get("candidatePins") == EXPECTED_PINS, "top-level source candidate pins drifted")
    verification = value.get("verificationBoundary")
    require(isinstance(verification, Mapping) and set(verification) == {"topLevelCandidatePinsRecorded", "runtimeComponentContractValidated", *EXPECTED_FALSE_VERIFICATION}, "verification boundary fields drifted")
    require(verification.get("topLevelCandidatePinsRecorded") is True, "top-level candidate pins are not recorded")
    require(verification.get("runtimeComponentContractValidated") is True, "runtime component contract is not validated")
    require(all(verification.get(field) is False for field in EXPECTED_FALSE_VERIFICATION), "unexecuted supply-chain verification is claimed")
    require(value.get("humanDecisions") == {
        "approved": list(HUMAN_DECISIONS),
        "pending": [],
        "attestationRecorded": True,
    }, "accountable human approval record drifted")
    require(value.get("productBoundary") == {
        "wording": "AirPlay-compatible wireless casting (not Apple-certified)",
        "fairPlayDrmSupported": False,
        "recordingSupported": False,
        "maximumBrowserViewers": 8,
        "validatedEnvelope": None,
    }, "product wording, DRM or media claim boundary drifted")
    require(value.get("executionBoundary") == {
        "networkDownloadPerformed": False,
        "imageBuildPerformed": False,
        "hostMutationPerformed": False,
        "receiverStarted": False,
        "receiverAdvertisementPerformed": False,
        "mediaProcessed": False,
    }, "source-only execution boundary drifted")
    require(value.get("claimBoundary") == {
        "sourceReviewPrepared": True,
        "sourceScaffoldReady": True,
        "componentContractReady": True,
        "componentReady": False,
        "deployable": False,
        "productAccepted": False,
        "releaseEligible": False,
        "task22_1Complete": False,
        "task22_3Complete": False,
        "task22_10Complete": False,
    }, "source-readiness evidence overclaims task or release completion")

    checks = value.get("checks")
    require(isinstance(checks, Mapping) and set(checks) == {"supplyChainReview", "trustedMediaScaffold", "trustedMediaRuntimeComponent", "strictOpenSpec"}, "source check set drifted")
    review = checks.get("supplyChainReview", {})
    scaffold = checks.get("trustedMediaScaffold", {})
    component = checks.get("trustedMediaRuntimeComponent", {})
    openspec = checks.get("strictOpenSpec", {})
    require(
        isinstance(review, Mapping)
        and review.get("valid") is True
        and review.get("componentCount") == 15
        and review.get("requiredHumanDecisionCount") == 5
        and review.get("approvedHumanDecisionCount") == 5
        and review.get("pendingHumanDecisionCount") == 0
        and review.get("allRequiredHumanDecisionsApproved") is True
        and review.get("automatedReleaseVerificationComplete") is False
        and review.get("releaseEligible") is False
        and review.get("task22_1Complete") is False,
        "recorded supply-chain review result drifted",
    )
    require(
        isinstance(scaffold, Mapping)
        and scaffold.get("valid") is True
        and scaffold.get("sourceScaffoldReady") is True
        and scaffold.get("deployable") is False
        and scaffold.get("componentReady") is False
        and scaffold.get("releaseEligible") is False
        and scaffold.get("task22_3Complete") is False,
        "recorded trusted-media scaffold result drifted",
    )
    require(
        isinstance(component, Mapping)
        and component.get("valid") is True
        and component.get("componentContractReady") is True
        and component.get("materialized") is False
        and component.get("componentReady") is False
        and component.get("releaseEligible") is False
        and component.get("task22_3Complete") is False,
        "recorded trusted-media runtime component result drifted",
    )
    require(openspec == {
        "passed": True,
        "command": "openspec validate build-team-ai-box-platform --strict",
        "exitCode": 0,
    }, "recorded strict OpenSpec check drifted")

    if revalidate:
        current = readiness_checks()
        require(current == checks, "current strict source checks no longer match the immutable record")
    return {
        "valid": True,
        "runId": run_id,
        "evidenceDigest": recorded_digest,
        "sourceScaffoldReady": True,
        "componentContractReady": True,
        "componentReady": False,
        "releaseEligible": False,
        "task22_1Complete": False,
        "task22_3Complete": False,
        "approvedHumanDecisionCount": len(HUMAN_DECISIONS),
        "pendingHumanGateCount": 0,
        "sourceCount": len(source_map),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    arguments = parser.parse_args()
    print(json.dumps(validate(arguments.evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
