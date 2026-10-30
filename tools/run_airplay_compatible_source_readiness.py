#!/usr/bin/env python3
"""Record immutable source-only readiness for the blocked casting runtime.

This runner performs no download, image build, host inspection, deployment,
receiver advertisement or media operation.  A passing record means only that
the exact candidate source/review/scaffold is internally coherent and remains
fail-closed behind its remaining automated supply-chain, hardware and
real-device gates.  Accountable human decisions are recorded separately.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any, Mapping

try:
    from .validate_airplay_compatible_supply_chain_review import validate as validate_review
    from .validate_trusted_media_runtime_component import validate_component_template
    from .validate_trusted_media_service_scaffold import validate as validate_scaffold
except ImportError:
    from validate_airplay_compatible_supply_chain_review import validate as validate_review
    from validate_trusted_media_runtime_component import validate_component_template
    from validate_trusted_media_service_scaffold import validate as validate_scaffold


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_ROOT = ROOT / "evidence/validation/supply-chain"
RUN_ID = re.compile(r"^airplay-compatible-source-readiness-[0-9]{8}-a[1-9][0-9]*$")
HUMAN_DECISIONS = (
    "uxplay-playfair-inherited-code-and-territorial-legality",
    "apple-mfi-trademark-copy-and-attribution",
    "h264-aac-alac-vp8-opus-and-nvidia-patent-clearance",
    "gplv3-lgpl-mpl-appliance-distribution-plan",
    "final-sbom-signature-provenance-vulnerability-and-source-mirror-acceptance",
)
SOURCE_PATHS = (
    "architecture/validation/airplay-compatible-supply-chain-review.v1.json",
    "architecture/validation/airplay-compatible-supply-chain-review.v2.json",
    "apps/platform-api/src/casting/trusted-media-runtime-client.mjs",
    "apps/platform-api/test/trusted-media-runtime-client.test.mjs",
    "apps/platform-api/server/trusted-media-runtime.mjs",
    "apps/platform-api/test/trusted-media-runtime-config.test.mjs",
    "deploy/casting/TrustedMediaService.arm64.Dockerfile",
    "deploy/casting/airplay-compatible-stack.lock.json",
    "deploy/casting/trusted-media-host-exceptions.v1.json",
    "deploy/casting/trusted-media-runtime-policy.v1.json",
    "deploy/casting/trusted-media-release-set.template.v1.json",
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
)


class SourceReadinessError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SourceReadinessError(message)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_digest(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def file_digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def source_records() -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    for relative in SOURCE_PATHS:
        path = (ROOT / relative).resolve()
        require(path.is_relative_to(ROOT) and path.is_file(), f"source is missing: {relative}")
        records.append({"path": relative, "sha256": file_digest(path)})
    return records


def strict_openspec() -> dict[str, object]:
    result = subprocess.run(
        ["openspec", "validate", "build-team-ai-box-platform", "--strict"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=180,
        check=False,
    )
    require(result.returncode == 0, "strict OpenSpec validation failed")
    return {
        "passed": True,
        "command": "openspec validate build-team-ai-box-platform --strict",
        "exitCode": 0,
    }


def readiness_checks() -> dict[str, Any]:
    review = validate_review()
    scaffold = validate_scaffold()
    component = validate_component_template()
    require(
        review.get("valid") is True
        and review.get("allRequiredHumanDecisionsApproved") is True
        and review.get("approvedHumanDecisionCount") == len(HUMAN_DECISIONS)
        and review.get("pendingHumanDecisionCount") == 0
        and review.get("automatedReleaseVerificationComplete") is False
        and review.get("releaseEligible") is False
        and review.get("task22_1Complete") is False,
        "source review approval or fail-closed technical boundary drifted",
    )
    require(
        scaffold.get("valid") is True
        and scaffold.get("sourceScaffoldReady") is True
        and scaffold.get("deployable") is False
        and scaffold.get("componentReady") is False
        and scaffold.get("task22_3Complete") is False,
        "trusted media scaffold overclaims readiness",
    )
    require(
        component.get("valid") is True
        and component.get("componentContractReady") is True
        and component.get("materialized") is False
        and component.get("componentReady") is False
        and component.get("task22_3Complete") is False,
        "trusted media runtime component contract overclaims readiness",
    )
    return {
        "supplyChainReview": review,
        "trustedMediaScaffold": scaffold,
        "trustedMediaRuntimeComponent": component,
        "strictOpenSpec": strict_openspec(),
    }


def build_document(
    run_id: str,
    *,
    started_at: str,
    completed_at: str,
    checks: Mapping[str, Any],
) -> dict[str, Any]:
    require(RUN_ID.fullmatch(run_id) is not None, "source-readiness run identity is invalid")
    review = checks.get("supplyChainReview", {})
    scaffold = checks.get("trustedMediaScaffold", {})
    component = checks.get("trustedMediaRuntimeComponent", {})
    openspec = checks.get("strictOpenSpec", {})
    require(
        isinstance(review, Mapping)
        and review.get("valid") is True
        and review.get("allRequiredHumanDecisionsApproved") is True
        and review.get("approvedHumanDecisionCount") == len(HUMAN_DECISIONS)
        and review.get("pendingHumanDecisionCount") == 0
        and review.get("automatedReleaseVerificationComplete") is False
        and review.get("releaseEligible") is False
        and review.get("task22_1Complete") is False,
        "source review approval or fail-closed technical boundary drifted",
    )
    require(
        isinstance(scaffold, Mapping)
        and scaffold.get("valid") is True
        and scaffold.get("sourceScaffoldReady") is True
        and scaffold.get("deployable") is False
        and scaffold.get("componentReady") is False
        and scaffold.get("task22_3Complete") is False,
        "trusted media scaffold check is not fail-closed",
    )
    require(
        isinstance(component, Mapping)
        and component.get("valid") is True
        and component.get("componentContractReady") is True
        and component.get("materialized") is False
        and component.get("componentReady") is False
        and component.get("task22_3Complete") is False,
        "trusted media runtime component check is not fail-closed",
    )
    require(isinstance(openspec, Mapping) and openspec.get("passed") is True, "strict OpenSpec check is missing")
    return {
        "schemaVersion": 1,
        "runnerId": "teamaibox.airplay-compatible-source-readiness.v1",
        "runId": run_id,
        "status": "passed",
        "startedAt": started_at,
        "completedAt": completed_at,
        "target": {
            "architecture": "linux/arm64/v8",
            "phase": "source-component-fail-closed",
            "remoteDeploymentPerformed": False,
            "liveStateObserved": False,
        },
        "sources": source_records(),
        "checks": dict(checks),
        "candidatePins": {
            "receiver": "UxPlay 1.73.6 @ 21eef8df25d91e12635c36d8176ad192725baca2",
            "mediaFramework": "GStreamer 1.28.6 @ 2d3e05cbdad68e47d645f548899b432dc9fb4473",
            "browserPublisher": "gst-plugin-webrtc 0.15.3 @ 75e46c3a1b868e9a08fd688d091476b76a498df1",
            "internalSfu": "LiveKit Server 1.13.6 @ 3cfbd1242618a61178f7a05b126d6c0c4cac3731",
            "browserViewer": "LiveKit browser client 2.21.0 @ 15ca5f8180ab8939c3a5a4dfee1d5e44f62f71cf",
        },
        "verificationBoundary": {
            "topLevelCandidatePinsRecorded": True,
            "runtimeComponentContractValidated": True,
            "completeTransitiveSbomVerified": False,
            "sourceArchiveDigestsVerified": False,
            "sourceSignaturesVerified": False,
            "finalArm64ImageBuilt": False,
            "finalArm64ImageDigestPinned": False,
            "finalImageSpdxVerified": False,
            "finalImageCycloneDxVerified": False,
            "finalImageSignatureVerified": False,
            "finalImageProvenanceVerified": False,
            "freshVulnerabilityEvidenceAccepted": False,
            "twoBuildReproducibilityVerified": False,
        },
        "humanDecisions": {
            "approved": list(HUMAN_DECISIONS),
            "pending": [],
            "attestationRecorded": True,
        },
        "productBoundary": {
            "wording": "AirPlay-compatible wireless casting (not Apple-certified)",
            "fairPlayDrmSupported": False,
            "recordingSupported": False,
            "maximumBrowserViewers": 8,
            "validatedEnvelope": None,
        },
        "executionBoundary": {
            "networkDownloadPerformed": False,
            "imageBuildPerformed": False,
            "hostMutationPerformed": False,
            "receiverStarted": False,
            "receiverAdvertisementPerformed": False,
            "mediaProcessed": False,
        },
        "claimBoundary": {
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
        },
    }


def atomic_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    require(not path.exists(), "source-readiness evidence identity is already occupied")
    unsigned = dict(value)
    unsigned.pop("evidenceDigest", None)
    value = dict(unsigned)
    value["evidenceDigest"] = canonical_digest(unsigned)
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8") + b"\n"
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".next", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        require(not path.exists(), "source-readiness evidence identity became occupied")
        os.link(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def run(run_id: str, output: Path) -> int:
    require(output.resolve().parent == EVIDENCE_ROOT.resolve(), "source-readiness output is outside its evidence scope")
    require(output.name == run_id + ".json", "source-readiness output does not match its run identity")
    started = utc_now()
    checks = readiness_checks()
    document = build_document(run_id, started_at=started, completed_at=utc_now(), checks=checks)
    atomic_write(output, document)
    print(json.dumps({
        "runId": run_id,
        "status": "passed",
        "evidence": output.relative_to(ROOT).as_posix(),
        "evidenceDigest": json.loads(output.read_text(encoding="utf-8"))["evidenceDigest"],
        "sourceScaffoldReady": True,
        "componentContractReady": True,
        "componentReady": False,
        "releaseEligible": False,
    }, sort_keys=True, separators=(",", ":")))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    arguments = parser.parse_args()
    run_id = arguments.run_id
    if RUN_ID.fullmatch(run_id) is None:
        parser.error("run ID must match airplay-compatible-source-readiness-YYYYMMDD-aN")
    return run(run_id, EVIDENCE_ROOT / f"{run_id}.json")


if __name__ == "__main__":
    raise SystemExit(main())
