#!/usr/bin/env python3
"""Strictly validate one exact AirPlay-compatible open-source release packet."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
from typing import Any, Mapping, Sequence

try:
    from .run_airplay_open_source_release_minimum import (
        EVIDENCE_ROOT, LOCK, ROOT, RUN_ID, SOURCE_PATHS, canonical_digest, docker_tool, file_digest,
    )
    from .validate_airplay_compatible_supply_chain_review import validate as validate_review
except ImportError:
    from run_airplay_open_source_release_minimum import (
        EVIDENCE_ROOT, LOCK, ROOT, RUN_ID, SOURCE_PATHS, canonical_digest, docker_tool, file_digest,
    )
    from validate_airplay_compatible_supply_chain_review import validate as validate_review


SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def artifact(record_path: object, digest: object, run_id: str) -> Path:
    require(isinstance(record_path, str) and not record_path.startswith("/") and ".." not in Path(record_path).parts, "artifact path is unsafe")
    path = (EVIDENCE_ROOT / record_path).resolve()
    expected_root = (EVIDENCE_ROOT / run_id).resolve()
    require(path.is_file() and path.is_relative_to(expected_root), "artifact is missing or outside the exact run")
    require(isinstance(digest, str) and SHA256.fullmatch(digest) is not None and file_digest(path) == digest, "artifact digest drifted")
    return path


def validate(path: Path, *, revalidate_signature: bool = True) -> dict[str, Any]:
    resolved = path.resolve()
    require(resolved.is_file() and resolved.parent == EVIDENCE_ROOT.resolve(), "release evidence path is invalid")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    digest = value.get("evidenceDigest")
    unsigned = dict(value)
    unsigned.pop("evidenceDigest", None)
    require(isinstance(digest, str) and SHA256.fullmatch(digest) is not None and digest == canonical_digest(unsigned), "release evidence digest drifted")
    run_id = value.get("runId")
    require(value.get("schemaVersion") == 1 and value.get("runnerId") == "teamaibox.airplay-open-source-release-minimum.v1" and isinstance(run_id, str) and RUN_ID.fullmatch(run_id) is not None and resolved.name == run_id + ".json" and value.get("status") == "passed", "release evidence identity is invalid")

    records = value.get("sources")
    require(isinstance(records, list) and len(records) == len(SOURCE_PATHS), "source binding count drifted")
    source_map = {}
    for record in records:
        require(isinstance(record, Mapping) and set(record) == {"path", "sha256"}, "source binding shape drifted")
        relative = record.get("path")
        require(isinstance(relative, str) and relative not in source_map and relative in SOURCE_PATHS, "source binding is unknown or duplicated")
        current = ROOT / relative
        require(current.is_file() and record.get("sha256") == file_digest(current), f"bound source drifted: {relative}")
        source_map[relative] = record["sha256"]
    require(set(source_map) == set(SOURCE_PATHS), "exact source binding set drifted")
    review = value.get("review")
    require(isinstance(review, Mapping) and review.get("sha256") == source_map["architecture/validation/airplay-compatible-supply-chain-review.v3.json"], "review binding drifted")
    review_current = validate_review(ROOT / str(review["path"]))
    require(review_current["allRequiredHumanDecisionsApproved"] is True and review.get("allRequiredHumanDecisionsApproved") is True, "human approval is incomplete")

    direct = value.get("directSources")
    require(isinstance(direct, list) and [item.get("name") for item in direct] == ["uxplay", "livekit-server", "livekit-client"] and all(item.get("verified") is True and SHA256.fullmatch(str(item.get("sha256"))) for item in direct), "direct source verification drifted")
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    require(direct[0]["sha256"] == lock["receiver"]["archiveSha256"] and direct[1]["sha256"] == lock["separateBrowserDelivery"]["sfuSource"]["archiveSha256"] and direct[2]["sha256"] == lock["separateBrowserDelivery"]["browserPackageTarballSha256"], "direct source digest no longer matches lock")

    image = value.get("image")
    require(isinstance(image, Mapping) and SHA256.fullmatch(str(image.get("contentDigest"))) is not None and image.get("architecture") == "arm64" and image.get("os") == "linux" and image.get("runtimeUser") == "65532:65532" and image.get("receiverVersion") == "1.73.6" and image.get("nonRoot") is True and image.get("dynamicLinksComplete") is True and image.get("requiredMediaElementsPresent") is True, "final ARM64 image inspection drifted")
    expected_packages = sorted(f"{name}={version}" for name, version in lock["directRuntimePackages"].items())
    require(image.get("observedDirectPackages") == expected_packages, "direct package revision binding drifted")

    spdx = value.get("spdx")
    require(isinstance(spdx, Mapping) and spdx.get("verified") is True and str(spdx.get("format", "")).startswith("SPDX-") and isinstance(spdx.get("packageCount"), int) and spdx["packageCount"] > 0, "SPDX gate failed")
    spdx_path = artifact(spdx.get("path"), spdx.get("sha256"), run_id)
    spdx_value = json.loads(spdx_path.read_text(encoding="utf-8"))
    require(spdx_value.get("spdxVersion") == spdx["format"] and len(spdx_value.get("packages", [])) == spdx["packageCount"], "SPDX content drifted")

    vulnerabilities = value.get("vulnerabilities")
    require(isinstance(vulnerabilities, Mapping) and vulnerabilities.get("criticalCount") == 0 and vulnerabilities.get("acceptedCriticalCount") == 0 and vulnerabilities.get("unacceptedCriticalCount") == 0 and vulnerabilities.get("accepted") is True, "Critical vulnerability gate failed")
    report_path = artifact(vulnerabilities.get("path"), vulnerabilities.get("sha256"), run_id)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    matches = report.get("matches", [])
    critical = [item for item in matches if str(item.get("vulnerability", {}).get("severity", "")).lower() == "critical"]
    require(len(matches) == vulnerabilities.get("matchCount") and not critical, "vulnerability report content drifted")

    signature = value.get("signature")
    require(isinstance(signature, Mapping) and signature.get("verified") is True and signature.get("privateKeyRetained") is False and signature.get("tool") == lock["verificationTools"]["cosign"], "image signature gate failed")
    subject_path = artifact(signature.get("subjectPath"), signature.get("subjectSha256"), run_id)
    signature_path = artifact(signature.get("signaturePath"), signature.get("signatureSha256"), run_id)
    public_path = artifact(signature.get("publicKeyPath"), signature.get("publicKeySha256"), run_id)
    require(not (public_path.parent / "release.key").exists() and not (public_path.parent / "cosign.env").exists(), "private signing material was retained")
    subject = json.loads(subject_path.read_text(encoding="utf-8"))
    require(subject == {"schemaVersion": 1, "subject": "teamaibox.trusted-media-service.open-source.v2", "architecture": "linux/arm64/v8", "imageContentDigest": image["contentDigest"], "sourceLockDigest": source_map["deploy/casting/airplay-compatible-stack.lock.v2.json"], "dockerfileDigest": source_map["deploy/casting/TrustedMediaService.arm64.v2.Dockerfile"], "spdxDigest": spdx["sha256"], "vulnerabilityReportDigest": vulnerabilities["sha256"]}, "signed image subject drifted")
    if revalidate_signature:
        result = docker_tool(lock["verificationTools"]["cosign"], ["verify-blob", "--insecure-ignore-tlog", "--key", "/work/" + public_path.name, "--signature", "/work/" + signature_path.name, "/work/" + subject_path.name], work=public_path.parent)
        require(b"Verified OK" in result.stdout or b"Verified OK" in result.stderr, "offline Cosign signature verification failed")

    require(value.get("optionalAssurance") == {"privateMirror": False, "airplaySpecificSlsa": False, "cycloneDx": False, "secondIndependentBuild": False, "required": False}, "optional assurance was promoted to a gate")
    require(value.get("executionBoundary") == {"imageBuiltLocally": True, "remoteDeploymentPerformed": False, "receiverStarted": False, "receiverAdvertised": False, "mediaProcessed": False}, "execution boundary drifted")
    require(value.get("claimBoundary") == {"openSourceReleaseMinimumComplete": True, "task22_1Complete": True, "task22_3Complete": False, "productAccepted": False, "releaseEligibleForDeployment": True, "receiverActivationAuthorized": False}, "release evidence overclaims product activation")
    return {"valid": True, "runId": run_id, "evidenceDigest": digest, "imageContentDigest": image["contentDigest"], "spdxPackageCount": spdx["packageCount"], "criticalCount": 0, "signatureVerified": True, "task22_1Complete": True, "task22_3Complete": False}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
