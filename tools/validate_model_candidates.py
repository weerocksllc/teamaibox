#!/usr/bin/env python3
"""Validate the pre-download model candidate and license gate matrix."""

from __future__ import annotations

import argparse
import json
import pathlib
import re
from datetime import datetime
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[1]
MATRIX = ROOT / "models" / "candidate-matrix.v1.json"
SCHEMA = ROOT / "models" / "candidate-matrix.v1.schema.json"

REQUIRED_COVERAGE = {
    "llm_agent", "large_nvfp4_llm", "image_drawing", "ocr", "asr",
    "translation",
}
HEX_REVISION = re.compile(r"^[a-f0-9]{40}$")
RELEASE_TAG = re.compile(r"^v[0-9]{8}$")
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
CANDIDATE_ID = re.compile(r"^[a-z][a-z0-9_.-]{2,127}$")
FORBIDDEN_KEYS = {
    "accessToken", "apiKey", "artifactDigest", "cachePath", "credential",
    "localPath", "objectId", "password", "secret", "token",
}


class ModelCandidateError(RuntimeError):
    pass


def _fail(message: str) -> None:
    raise ModelCandidateError(message)


def _exact(value: Any, required: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != required:
        _fail(f"{label} must contain exactly {sorted(required)}")
    return value


def _timestamp(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.endswith("Z"):
        _fail(f"{label} must be a canonical UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ModelCandidateError(f"{label} must be a canonical UTC timestamp") from error
    if parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z") != value:
        _fail(f"{label} must retain millisecond precision")
    return value


def _https(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.startswith("https://") or "@" in value.split("/", 3)[2]:
        _fail(f"{label} must be HTTPS without credentials")
    return value


def _walk_forbidden(value: Any, label: str = "matrix") -> None:
    if isinstance(value, list):
        for index, item in enumerate(value):
            _walk_forbidden(item, f"{label}[{index}]")
    elif isinstance(value, dict):
        for key, item in value.items():
            if key in FORBIDDEN_KEYS:
                _fail(f"{label}.{key} is forbidden before content-addressed import")
            _walk_forbidden(item, f"{label}.{key}")


def validate(matrix: dict[str, Any]) -> dict[str, int]:
    _exact(matrix, {
        "schemaVersion", "researchSnapshotAt", "target", "downloadGate",
        "coverage", "researchSources", "candidates",
    }, "matrix")
    if matrix["schemaVersion"] != 1:
        _fail("only candidate matrix schemaVersion 1 is supported")
    _timestamp(matrix["researchSnapshotAt"], "researchSnapshotAt")
    _walk_forbidden(matrix)

    target = _exact(matrix["target"], {
        "nodeKey", "architecture", "accelerator", "unifiedMemoryBytes", "containerFirst",
    }, "target")
    if target != {
        "nodeKey": "dgx-spark-dev-01",
        "architecture": "linux/arm64/v8",
        "accelerator": "nvidia-gb10-blackwell",
        "unifiedMemoryBytes": 137438953472,
        "containerFirst": True,
    }:
        _fail("candidate target must preserve the observed DGX Spark boundary")

    gate = _exact(matrix["downloadGate"], {
        "metadataOnlyDuringDiscovery", "requireExactRevision", "requireReviewedLicense",
        "requireChecksumBeforeCommit", "allowedLicenseReviewStates",
    }, "downloadGate")
    if gate != {
        "metadataOnlyDuringDiscovery": True,
        "requireExactRevision": True,
        "requireReviewedLicense": True,
        "requireChecksumBeforeCommit": True,
        "allowedLicenseReviewStates": ["approved"],
    }:
        _fail("the pre-download license, revision, and checksum gates cannot be weakened")

    coverage = matrix["coverage"]
    if not isinstance(coverage, list) or len(coverage) != len(set(coverage)) or set(coverage) != REQUIRED_COVERAGE:
        _fail("candidate coverage must contain every required initial workload exactly once")

    source_ids: set[str] = set()
    for index, source in enumerate(matrix["researchSources"]):
        source = _exact(source, {"sourceId", "publisher", "uri", "retrievedAt"}, f"researchSources[{index}]")
        if not CANDIDATE_ID.fullmatch(source["sourceId"]) or source["sourceId"] in source_ids:
            _fail("research source IDs must be unique stable keys")
        source_ids.add(source["sourceId"])
        if not isinstance(source["publisher"], str) or not source["publisher"]:
            _fail("research source publisher is required")
        _https(source["uri"], f"researchSources[{index}].uri")
        _timestamp(source["retrievedAt"], f"researchSources[{index}].retrievedAt")

    candidates = matrix["candidates"]
    if not isinstance(candidates, list) or len(candidates) < len(REQUIRED_COVERAGE):
        _fail("candidate matrix is incomplete")
    candidate_ids: set[str] = set()
    by_id: dict[str, dict[str, Any]] = {}
    eligible_coverage: set[str] = set()
    allowed_downloads = blocked_downloads = 0

    for index, candidate in enumerate(candidates):
        label = f"candidates[{index}]"
        candidate = _exact(candidate, {
            "candidateId", "role", "useCases", "source", "license",
            "artifactDecision", "precision", "engine", "selection",
        }, label)
        candidate_id = candidate["candidateId"]
        if not isinstance(candidate_id, str) or not CANDIDATE_ID.fullmatch(candidate_id) or candidate_id in candidate_ids:
            _fail("candidate IDs must be unique stable keys")
        candidate_ids.add(candidate_id)
        by_id[candidate_id] = candidate
        use_cases = candidate["useCases"]
        if not isinstance(use_cases, list) or not use_cases or len(use_cases) != len(set(use_cases)) or not set(use_cases) <= REQUIRED_COVERAGE:
            _fail(f"{candidate_id} has invalid or duplicate use cases")

        source = _exact(candidate["source"], {
            "publisher", "repository", "revision", "provenanceUri",
            "artifactSourceUri", "gated", "reportedRepositoryBytes",
        }, f"{candidate_id}.source")
        revision = source["revision"]
        if not isinstance(revision, str) or not (HEX_REVISION.fullmatch(revision) or RELEASE_TAG.fullmatch(revision)):
            _fail(f"{candidate_id} source revision is not immutable")
        provenance = _https(source["provenanceUri"], f"{candidate_id}.source.provenanceUri")
        artifact_source = _https(source["artifactSourceUri"], f"{candidate_id}.source.artifactSourceUri")
        if revision not in provenance:
            _fail(f"{candidate_id} provenance URI is not revision pinned")
        if revision not in artifact_source and not re.search(r"/[a-f0-9]{64}/", artifact_source):
            _fail(f"{candidate_id} artifact source lacks a revision or checksum pin")
        if not isinstance(source["gated"], bool):
            _fail(f"{candidate_id} source gated state is required")
        if source["reportedRepositoryBytes"] is not None and (
            not isinstance(source["reportedRepositoryBytes"], int) or source["reportedRepositoryBytes"] < 1
        ):
            _fail(f"{candidate_id} repository size is invalid")

        license_record = _exact(candidate["license"], {
            "identifier", "usage", "reviewStatus", "reviewedAt", "reviewedBy",
            "evidenceUri", "evidenceDigest", "conditions",
        }, f"{candidate_id}.license")
        if license_record["reviewStatus"] not in {"approved", "conditional", "rejected"}:
            _fail(f"{candidate_id} license review state is invalid")
        if license_record["usage"] not in {"commercial", "conditional-commercial", "non-commercial", "unknown"}:
            _fail(f"{candidate_id} license usage is invalid")
        if license_record["reviewedBy"] != "model-discovery-policy-v1":
            _fail(f"{candidate_id} license review provenance is invalid")
        _timestamp(license_record["reviewedAt"], f"{candidate_id}.license.reviewedAt")
        evidence_uri = _https(license_record["evidenceUri"], f"{candidate_id}.license.evidenceUri")
        if revision not in evidence_uri:
            _fail(f"{candidate_id} license evidence is not revision pinned")
        if not isinstance(license_record["evidenceDigest"], str) or not DIGEST.fullmatch(license_record["evidenceDigest"]):
            _fail(f"{candidate_id} license evidence digest is invalid")
        if not isinstance(license_record["conditions"], list) or not license_record["conditions"]:
            _fail(f"{candidate_id} license obligations must be explicit")

        artifact = _exact(candidate["artifactDecision"], {
            "status", "reason", "maximumDownloadBytes", "downloadState", "allowPatterns",
        }, f"{candidate_id}.artifactDecision")
        if artifact["downloadState"] != "not_downloaded":
            _fail(f"{candidate_id} downloaded artifacts during discovery")
        if not isinstance(artifact["reason"], str) or not artifact["reason"]:
            _fail(f"{candidate_id} artifact decision needs a reason")
        if artifact["status"] == "allowed":
            allowed_downloads += 1
            if license_record["reviewStatus"] != "approved" or license_record["usage"] in {"non-commercial", "unknown"}:
                _fail(f"{candidate_id} cannot download before an approved usable license")
            if source["gated"]:
                _fail(f"{candidate_id} cannot download a gated source without an approval reference")
            if not isinstance(artifact["maximumDownloadBytes"], int) or artifact["maximumDownloadBytes"] < 1:
                _fail(f"{candidate_id} download needs a positive quota ceiling")
            if not isinstance(artifact["allowPatterns"], list) or not artifact["allowPatterns"]:
                _fail(f"{candidate_id} download needs an artifact allowlist")
        elif artifact["status"] == "blocked":
            blocked_downloads += 1
            if artifact["maximumDownloadBytes"] is not None or artifact["allowPatterns"] != []:
                _fail(f"{candidate_id} blocked download cannot reserve bytes or artifact patterns")
        else:
            _fail(f"{candidate_id} artifact decision is invalid")

        precision = _exact(candidate["precision"], {
            "kind", "nvfp4Applicability", "evidenceUri", "baselineCandidateId", "comparisonReferences",
        }, f"{candidate_id}.precision")
        kind = precision["kind"]
        applicability = precision["nvfp4Applicability"]
        if kind == "nvfp4" and applicability != "official-prequantized":
            _fail(f"{candidate_id} cannot claim NVFP4 without an official exact profile")
        if applicability == "official-prequantized" and kind != "nvfp4":
            _fail(f"{candidate_id} NVFP4 applicability disagrees with precision")
        if kind == "mxfp4" and applicability != "different-fp4-format":
            _fail(f"{candidate_id} must keep MXFP4 distinct from NVFP4")
        if applicability in {"official-prequantized", "baseline-for-nvfp4", "different-fp4-format"}:
            _https(precision["evidenceUri"], f"{candidate_id}.precision.evidenceUri")
        elif precision["evidenceUri"] is not None:
            _https(precision["evidenceUri"], f"{candidate_id}.precision.evidenceUri")
        comparisons = precision["comparisonReferences"]
        if not isinstance(comparisons, list):
            _fail(f"{candidate_id} comparison references must be an array")
        for comparison in comparisons:
            comparison = _exact(comparison, {
                "repository", "revision", "precision", "executionRequirement", "downloadStatus",
            }, f"{candidate_id}.comparisonReference")
            if not HEX_REVISION.fullmatch(comparison["revision"]):
                _fail(f"{candidate_id} comparison revision is not immutable")
            if comparison["downloadStatus"] != "blocked-until-benchmark-plan":
                _fail(f"{candidate_id} comparison cannot download before a benchmark plan")

        engine = _exact(candidate["engine"], {
            "name", "compatibilityStatus", "targetArchitecture", "resourceMode", "notes",
        }, f"{candidate_id}.engine")
        if engine["targetArchitecture"] != "linux/arm64/v8":
            _fail(f"{candidate_id} is not targeted to the Spark architecture")

        selection = _exact(candidate["selection"], {"status", "rationale"}, f"{candidate_id}.selection")
        if selection["status"] == "planned":
            if artifact["status"] != "allowed":
                _fail(f"{candidate_id} planned selection must pass the download gate")
            eligible_coverage.update(use_cases)
        elif selection["status"] in {"hold", "rejected"}:
            if artifact["status"] != "blocked":
                _fail(f"{candidate_id} held or rejected selection must block download")
            if selection["status"] == "hold":
                eligible_coverage.update(use_cases)
        else:
            _fail(f"{candidate_id} selection state is invalid")
        if candidate["role"] == "rejected" or license_record["reviewStatus"] == "rejected":
            if selection["status"] != "rejected" or artifact["status"] != "blocked":
                _fail(f"{candidate_id} rejected license must fail closed")

    for candidate_id, candidate in by_id.items():
        baseline = candidate["precision"]["baselineCandidateId"]
        if baseline is not None and baseline not in by_id:
            _fail(f"{candidate_id} references an unknown comparison baseline")
    if eligible_coverage != REQUIRED_COVERAGE:
        _fail(f"eligible candidate coverage is incomplete: {sorted(REQUIRED_COVERAGE - eligible_coverage)}")
    if not any(item["precision"]["kind"] == "nvfp4" and item["selection"]["status"] == "planned" for item in candidates):
        _fail("the first matrix requires one download-eligible exact NVFP4 candidate")
    if not any(item["role"] == "rejected" and item["license"]["usage"] == "non-commercial" for item in candidates):
        _fail("the license gate needs an executable non-commercial rejection scenario")

    return {
        "candidates": len(candidates),
        "coverage": len(eligible_coverage),
        "allowedDownloads": allowed_downloads,
        "blockedDownloads": blocked_downloads,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix", type=pathlib.Path, default=MATRIX)
    args = parser.parse_args()
    json.loads(SCHEMA.read_text(encoding="utf-8"))
    matrix = json.loads(args.matrix.read_text(encoding="utf-8"))
    try:
        summary = validate(matrix)
    except ModelCandidateError as error:
        parser.error(str(error))
    print(
        "model candidate matrix valid: "
        f"{summary['candidates']} candidates, {summary['coverage']} workloads, "
        f"{summary['allowedDownloads']} allowed, {summary['blockedDownloads']} blocked"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
