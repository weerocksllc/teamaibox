#!/usr/bin/env python3
"""Evaluate the closed release-candidate gate without publishing a release."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import time
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

try:
    from .validate_appliance_browser_acceptance import validate as validate_appliance_browser_acceptance
except ImportError:
    from validate_appliance_browser_acceptance import validate as validate_appliance_browser_acceptance


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "architecture" / "validation" / "release-candidate-gate.v1.json"
EVIDENCE_ROOT = ROOT / "evidence" / "validation" / "releases"
RUN_ID = re.compile(r"release-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}")
SHA256 = re.compile(r"sha256:[a-f0-9]{64}")
REVISION = re.compile(r"[a-f0-9]{40,64}")
CANDIDATE = re.compile(r"rc-[a-z0-9][a-z0-9.-]{2,95}")
COMMAND_KEYS = ["strict_openspec", "ci", "no_regression"]
ARTIFACT_KEYS = ["real_spark_smoke", "certified_model_evidence", "soak_selection", "backup_restore", "security", "upgrade_rollback", "appliance_acceptance"]
ARTIFACT_CLASSES = ["real_spark_smoke", "certified_model", "model_soak", "backup_restore", "security", "upgrade_rollback", "appliance_acceptance"]
ALLOWED_TOOLS = {"openspec", "pnpm", "python3"}


class ReleaseGateError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReleaseGateError(message)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def parse_time(value: Any, field: str) -> datetime:
    require(isinstance(value, str) and value.endswith("Z"), f"{field} must be a UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ReleaseGateError(f"{field} is invalid") from error
    require(parsed.tzinfo is not None, f"{field} must include timezone")
    return parsed


def repository_path(root: Path, value: Any, label: str) -> Path:
    require(isinstance(value, str), f"{label} path must be a string")
    relative = PurePosixPath(value)
    require(not relative.is_absolute() and ".." not in relative.parts, f"{label} path escapes the evidence root")
    path = root / relative
    require(path.is_file(), f"{label} path is missing: {value}")
    return path


def validate_catalog(value: Mapping[str, Any]) -> dict[str, Any]:
    require(set(value) == {"schemaVersion", "suiteId", "maximumFailures", "retainCommandOutput", "requireCleanWorktree", "commandGates", "artifactGates"}, "release gate catalog fields drifted")
    require(value.get("schemaVersion") == 1 and value.get("suiteId") == "release.candidate-gate.v1", "release gate identity drifted")
    require(value.get("maximumFailures") == 0 and value.get("retainCommandOutput") is False and value.get("requireCleanWorktree") is True, "release gate must remain fail-closed, redacted, and clean-tree only")
    commands = value.get("commandGates")
    require(isinstance(commands, list) and [item.get("key") for item in commands if isinstance(item, Mapping)] == COMMAND_KEYS, "release command gate coverage or order drifted")
    for gate in commands:
        require(set(gate) == {"key", "commands"} and isinstance(gate["commands"], list) and gate["commands"], f"release command gate {gate.get('key')} is invalid")
        for command in gate["commands"]:
            require(isinstance(command, list) and 2 <= len(command) <= 18 and command[0] in ALLOWED_TOOLS, f"release command gate {gate.get('key')} command is invalid")
            require(all(isinstance(arg, str) and 1 <= len(arg) <= 512 and not any(ord(char) < 32 for char in arg) for arg in command), "release command contains an invalid argument")
    artifacts = value.get("artifactGates")
    require(isinstance(artifacts, list) and [item.get("key") for item in artifacts if isinstance(item, Mapping)] == ARTIFACT_KEYS, "release artifact gate coverage or order drifted")
    require([item.get("evidenceClass") for item in artifacts] == ARTIFACT_CLASSES, "release evidence class coverage drifted")
    require([item.get("cardinality") for item in artifacts] == ["exactly_one", "one_or_more", "one_per_certified_model", "exactly_one", "exactly_one", "exactly_one", "exactly_one"], "release evidence cardinality drifted")
    return dict(value)


def validate_claims(evidence_class: str, claims: Mapping[str, Any]) -> None:
    exact_true: dict[str, list[str]] = {
        "real_spark_smoke": ["claimEligible", "cleanupPassed", "residualStatePassed", "currentHardware", "containerizedAppliance"],
        "certified_model": ["productionRoutingEligible", "conformancePassed", "qualityPassed", "resourceEnvelopePassed", "faultsPassed"],
        "model_soak": ["memoryPassed", "thermalPassed", "throughputPassed", "zeroCrashes", "zeroLostJobs", "zeroDuplicateJobs"],
        "backup_restore": ["independentTarget", "integrityPassed", "disposableRestorePassed", "rpoPassed", "rtoPassed"],
        "security": ["closedGatePassed", "dependencyPassed", "imagePassed", "secretPassed", "authorizationPassed", "isolationPassed", "recoveryMaterialPassed"],
        "upgrade_rollback": ["upgradePassed", "rollbackRehearsalPassed", "postRollbackHealthPassed", "dataIntegrityPassed", "modelRevalidationPassed"],
        "appliance_acceptance": ["releaseEvidenceEligible", "supportedContainerizedAppliance", "hostAllowlistConforming", "currentSparkHardwareCheckpoints", "authenticatedHttpsJourneys", "realBrowser", "administratorJourneyPassed", "ordinaryUserJourneyPassed", "localeThemeViewportMatrixPassed", "sessionAndCsrfPassed", "sseAndWebSocketPassed"],
    }
    for key in exact_true[evidence_class]:
        require(claims.get(key) is True, f"{evidence_class} claim {key} must be true")
    if evidence_class == "real_spark_smoke":
        require(claims.get("architecture") == "linux/arm64/v8", "Spark smoke architecture is not ARM64")
    elif evidence_class == "certified_model":
        require(isinstance(claims.get("profileId"), str) and claims.get("lifecycleState") == "Certified", "model profile is not Certified")
        require(SHA256.fullmatch(str(claims.get("modelEvidenceDigest", ""))) is not None, "model evidence digest is invalid")
    elif evidence_class == "model_soak":
        require(isinstance(claims.get("profileId"), str), "soak profileId is invalid")
        risk = claims.get("riskClass")
        selected = claims.get("selectedDurationHours")
        completed = claims.get("completedDurationSeconds")
        require(risk in {"standard", "critical", "high_memory", "nvfp4"}, "soak risk class is invalid")
        require(selected in {8, 24} and isinstance(completed, int) and completed >= selected * 3600, "soak duration is incomplete")
        require(selected == (24 if risk in {"critical", "high_memory", "nvfp4"} else 8), "soak risk selection is invalid")
        require(claims.get("smoke") is False, "smoke soak cannot satisfy the release gate")
    elif evidence_class == "backup_restore":
        require(isinstance(claims.get("backupSetId"), str) and isinstance(claims.get("restoreRunId"), str), "backup/restore identities are missing")
    elif evidence_class == "security":
        require(claims.get("failedGateCount") == 0, "security evidence contains failed gates")
    elif evidence_class == "upgrade_rollback":
        require(SHA256.fullmatch(str(claims.get("previousReleaseDigest", ""))) is not None, "previous release digest is invalid")
    elif evidence_class == "appliance_acceptance":
        require(claims.get("originClass") == "supported-appliance-authenticated-https", "appliance acceptance origin class is not release eligible")
        origin = urlsplit(str(claims.get("origin", "")))
        require(origin.scheme == "https" and origin.hostname not in {None, "localhost", "127.0.0.1", "::1"}, "appliance acceptance origin is not non-local HTTPS")
        require(origin.username is None and origin.password is None and origin.query == "" and origin.fragment == "", "appliance acceptance origin contains credentials or ambiguous components")
        require(origin.path in {"", "/"}, "appliance acceptance origin must identify the appliance root")
        require(claims.get("target") == "dgx-spark-dev-01" and claims.get("architecture") == "linux/arm64/v8", "appliance acceptance target is not the supported Spark")
        require(claims.get("certificateTrust") in {"public-ca-browser-trusted", "private-appliance-ca-browser-trusted"}, "appliance acceptance certificate is not browser trusted")
        require(isinstance(claims.get("browserName"), str) and 2 <= len(claims["browserName"]) <= 80, "appliance acceptance browser identity is missing")
        require(claims.get("browserExecution") == "real-browser", "appliance acceptance did not use a real browser")
        require(claims.get("matrixCombinationCount") == 8, "appliance acceptance locale/theme/viewport matrix is incomplete")
        require(isinstance(claims.get("administratorJourneyCount"), int) and claims["administratorJourneyCount"] >= 1, "administrator HTTPS journey coverage is missing")
        require(isinstance(claims.get("ordinaryUserJourneyCount"), int) and claims["ordinaryUserJourneyCount"] >= 1, "ordinary-user HTTPS journey coverage is missing")
        require(claims.get("hostAllowlistDriftCount") == 0, "appliance acceptance contains host drift")
        age = claims.get("hardwareCheckpointAgeSeconds")
        maximum = claims.get("hardwareCheckpointMaximumAgeSeconds")
        require(isinstance(age, int) and isinstance(maximum, int) and 0 <= age <= maximum <= 3600, "Spark hardware checkpoints are stale")
        for field in ("deploymentEvidenceDigest", "hostDriftEvidenceDigest", "hardwareEvidenceDigest", "browserEvidenceDigest"):
            require(SHA256.fullmatch(str(claims.get(field, ""))) is not None, f"appliance acceptance {field} is invalid")


def validate_manifest_and_evidence(manifest: Mapping[str, Any], *, evidence_root: Path, evaluated_at: datetime | None = None) -> list[dict[str, Any]]:
    expected = {"schemaVersion", "releaseCandidateId", "releaseDigest", "sourceRevision", "sourceTreeDigest", "environmentDigest", "createdAt", "evidence"}
    require(set(manifest) == expected and manifest.get("schemaVersion") == 1, "release candidate manifest fields drifted")
    require(CANDIDATE.fullmatch(str(manifest.get("releaseCandidateId", ""))) is not None, "release candidate ID is invalid")
    for field in ("releaseDigest", "sourceTreeDigest", "environmentDigest"):
        require(SHA256.fullmatch(str(manifest.get(field, ""))) is not None, f"{field} is invalid")
    require(REVISION.fullmatch(str(manifest.get("sourceRevision", ""))) is not None, "sourceRevision is invalid")
    created_at = parse_time(manifest.get("createdAt"), "createdAt")
    now = evaluated_at or datetime.now(timezone.utc)
    require(created_at <= now, "release candidate manifest is from the future")
    references = manifest.get("evidence")
    require(isinstance(references, list) and references, "release candidate evidence list is empty")

    values: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    for reference in references:
        require(isinstance(reference, Mapping) and set(reference) == {"path", "digest"}, "release evidence reference is invalid")
        require(reference["path"] not in seen_paths, "release evidence path is duplicated")
        seen_paths.add(reference["path"])
        path = repository_path(evidence_root, reference["path"], "release evidence")
        raw = path.read_bytes()
        require(digest_bytes(raw) == reference["digest"], f"release evidence digest mismatch: {reference['path']}")
        value = json.loads(raw)
        require(isinstance(value, Mapping), "release evidence must be an object")
        required = {"schemaVersion", "evidenceClass", "releaseCandidateId", "releaseDigest", "sourceRevision", "sourceTreeDigest", "environmentDigest", "status", "startedAt", "completedAt", "expiresAt", "claims", "sourceEvidence", "commandOutputRetained"}
        require(set(value) == required and value.get("schemaVersion") == 1, "release evidence envelope fields drifted")
        evidence_class = value.get("evidenceClass")
        require(evidence_class in ARTIFACT_CLASSES, "release evidence class is unknown")
        for field in ("releaseCandidateId", "releaseDigest", "sourceRevision", "sourceTreeDigest", "environmentDigest"):
            require(value.get(field) == manifest[field], f"{evidence_class} does not bind {field}")
        require(value.get("status") == "passed" and value.get("commandOutputRetained") is False, f"{evidence_class} evidence did not pass or retained output")
        started, completed, expires = parse_time(value.get("startedAt"), "startedAt"), parse_time(value.get("completedAt"), "completedAt"), parse_time(value.get("expiresAt"), "expiresAt")
        require(started <= completed <= now < expires, f"{evidence_class} evidence time window is invalid or stale")
        claims = value.get("claims")
        require(isinstance(claims, Mapping), f"{evidence_class} claims are invalid")
        validate_claims(evidence_class, claims)
        source_evidence = value.get("sourceEvidence")
        require(isinstance(source_evidence, list) and source_evidence, f"{evidence_class} source evidence is empty")
        source_paths = []
        for source in source_evidence:
            require(isinstance(source, Mapping) and set(source) == {"path", "digest"} and SHA256.fullmatch(str(source.get("digest", ""))) is not None, f"{evidence_class} source evidence reference is invalid")
            source_path = repository_path(evidence_root, source["path"], "source evidence")
            require(digest_bytes(source_path.read_bytes()) == source["digest"], f"{evidence_class} source evidence digest mismatch")
            source_paths.append(source_path)
        if evidence_class == "appliance_acceptance":
            browser_reports = []
            for source_path in source_paths:
                try:
                    candidate = json.loads(source_path.read_text(encoding="utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if isinstance(candidate, Mapping) and candidate.get("suiteId") == "browser.appliance-authenticated-https.v1":
                    browser_reports.append(source_path)
            require(len(browser_reports) == 1, "appliance acceptance must reference exactly one validated real-browser report")
            try:
                browser_result = validate_appliance_browser_acceptance(browser_reports[0], evaluated_at=completed)
            except (ValueError, OSError, json.JSONDecodeError) as error:
                raise ReleaseGateError(f"appliance acceptance browser report failed: {error}") from error
            require(candidate_id := value.get("releaseCandidateId"), "appliance acceptance release candidate is missing")
            report_value = json.loads(browser_reports[0].read_text(encoding="utf-8"))
            require(report_value.get("releaseCandidateId") == candidate_id, "appliance browser report does not bind the release candidate")
            require(dict(claims) == browser_result["claims"], "appliance acceptance claims were not derived from the validated browser report")
        values.append(dict(value))

    grouped = {key: [value for value in values if value["evidenceClass"] == key] for key in ARTIFACT_CLASSES}
    for key in ("real_spark_smoke", "backup_restore", "security", "upgrade_rollback", "appliance_acceptance"):
        require(len(grouped[key]) == 1, f"release gate requires exactly one {key} evidence")
    require(len(grouped["certified_model"]) >= 1, "release gate requires at least one certified model")
    certified_ids = [item["claims"]["profileId"] for item in grouped["certified_model"]]
    soak_ids = [item["claims"]["profileId"] for item in grouped["model_soak"]]
    require(len(certified_ids) == len(set(certified_ids)), "certified model profile is duplicated")
    require(len(soak_ids) == len(set(soak_ids)) and sorted(soak_ids) == sorted(certified_ids), "soak evidence must match every and only certified model")
    return values


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def run_command(argv: Sequence[str], timeout_seconds: int) -> dict[str, Any]:
    started = time.monotonic()
    try:
        completed = subprocess.run(list(argv), cwd=ROOT, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout_seconds, env=os.environ.copy())
        code, stdout, stderr, timed_out = completed.returncode, completed.stdout, completed.stderr, False
    except subprocess.TimeoutExpired as error:
        code, stdout, stderr, timed_out = 124, error.stdout or b"", error.stderr or b"", True
    return {"argvDigest": digest_bytes(canonical_bytes(list(argv))), "exitCode": code, "timedOut": timed_out, "durationMilliseconds": round((time.monotonic() - started) * 1000), "stdoutDigest": digest_bytes(stdout), "stderrDigest": digest_bytes(stderr)}


def git_facts() -> dict[str, Any]:
    revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()
    status = subprocess.run(["git", "status", "--porcelain=v1", "-z"], cwd=ROOT, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
    return {"head": revision, "worktreeDirty": bool(status), "changedPathCount": len([item for item in status.split(b"\0") if item])}


def write_evidence(value: Mapping[str, Any], replace: bool) -> Path:
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    target = EVIDENCE_ROOT / f"{value['runId']}.json"
    require(replace or not target.exists(), "release gate evidence already exists; use a new run id")
    temporary = target.with_suffix(".json.tmp")
    temporary.write_bytes(canonical_bytes(value) + b"\n")
    os.replace(temporary, target)
    return target


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args(argv)
    require(RUN_ID.fullmatch(args.run_id) is not None, "run ID must match release-YYYYMMDD-name")
    require(30 <= args.timeout_seconds <= 3600, "timeout must be between 30 and 3600 seconds")
    catalog = validate_catalog(json.loads(CATALOG.read_text(encoding="utf-8")))
    manifest_path = args.manifest.resolve()
    require(manifest_path.is_file(), "release candidate manifest is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    artifacts = validate_manifest_and_evidence(manifest, evidence_root=manifest_path.parent)
    source = git_facts()
    command_results = []
    for gate in catalog["commandGates"]:
        results = [run_command(command, args.timeout_seconds) for command in gate["commands"]]
        command_results.append({"key": gate["key"], "status": "passed" if all(item["exitCode"] == 0 for item in results) else "failed", "commands": results})
    failed = [item["key"] for item in command_results if item["status"] != "passed"]
    if catalog["requireCleanWorktree"] and source["worktreeDirty"]:
        failed.append("clean_worktree")
    if source["head"] != manifest["sourceRevision"]:
        failed.append("source_revision")
    failed = list(dict.fromkeys(failed))
    status = "passed" if len(failed) <= catalog["maximumFailures"] else "failed"
    result = {"schemaVersion": 1, "suiteId": catalog["suiteId"], "runId": args.run_id, "releaseCandidateId": manifest["releaseCandidateId"], "releaseDigest": manifest["releaseDigest"], "status": status, "promotionEligible": status == "passed", "completedAt": iso_now(), "source": {**source, "catalogDigest": digest_bytes(canonical_bytes(catalog)), "manifestDigest": digest_bytes(manifest_path.read_bytes())}, "failedGateKeys": failed, "commandGates": command_results, "artifactEvidence": [{"evidenceClass": item["evidenceClass"], "claimsDigest": digest_bytes(canonical_bytes(item["claims"]))} for item in artifacts], "commandOutputRetained": False}
    target = write_evidence(result, args.replace)
    print(json.dumps({"runId": args.run_id, "status": status, "promotionEligible": result["promotionEligible"], "failedGateKeys": failed, "evidence": target.relative_to(ROOT).as_posix()}, sort_keys=True, separators=(",", ":")))
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ReleaseGateError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f"release candidate gate failed: {error}", file=sys.stderr)
        raise SystemExit(2)
