#!/usr/bin/env python3
"""Audit every historical evidence JSON without promoting legacy records to feature acceptance."""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import re
from typing import Any, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "architecture" / "validation" / "historical-evidence-audit.v1.json"
EVIDENCE_ROOT = ROOT / "evidence"
CURRENT_FEATURE_FIELDS = {
    "schemaVersion", "evidenceId", "featureKey", "catalogDigest", "runId", "status", "startedAt",
    "completedAt", "source", "deployment", "sparkInventory", "configuration", "health", "journeys",
    "restart", "rollback", "residualState", "limitations", "humanGates", "successfulParent", "privacy",
    "evidenceDigest",
}
PASSING = {"passed", "valid", "completed", "success", "succeeded", "accepted"}
FAILING = {"failed", "aborted", "blocked", "pending", "incomplete", "error"}


class HistoricalEvidenceAuditError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise HistoricalEvidenceAuditError(message)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest_bytes(value: bytes) -> str:
    import hashlib
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _status_values(value: Mapping[str, Any]) -> list[str]:
    fields = ["status", "outcome", "result", "state", "classification"]
    return [str(value[key]).lower() for key in fields if isinstance(value.get(key), str)]


def historically_passing(value: Mapping[str, Any]) -> bool:
    statuses = _status_values(value)
    return (
        any(status in PASSING or status.endswith("_passed") for status in statuses)
        or value.get("valid") is True
        or value.get("claimEligible") is True and value.get("failure") is None
        or value.get("releaseEvidenceEligible") is True
    )


def failed_or_incomplete(path: str, value: Mapping[str, Any]) -> bool:
    statuses = _status_values(value)
    return (
        any(status in FAILING or status.startswith("failed") or status.endswith("_pending") for status in statuses)
        or "failed" in path or "aborted" in path
        or value.get("failure") not in (None, False, "")
    )


def classify(path: str, value: Mapping[str, Any], retained: set[str]) -> str:
    normalized = path.lower()
    serialized = json.dumps(value, sort_keys=True).lower()
    if path in retained:
        return "retained-prerequisite-only"
    if set(value) == CURRENT_FEATURE_FIELDS:
        return "current-feature-evidence"
    if "preview" in normalized or "workbench-preview" in serialized:
        return "stale-preview"
    if normalized.endswith("/ai-applications-20260811-development-a1.json") or "/browser/" in normalized:
        return "static-fixture"
    if normalized.endswith("/journeys-20260811-development-a1.json"):
        return "memory-repository"
    if "/load/" in normalized or "synthetic" in serialized or "service-objective" in serialized:
        return "synthetic-service-objective"
    if "external-provider" in normalized or "provider fixture" in serialized or "contract-fixture" in serialized:
        return "contract-only-provider"
    if failed_or_incomplete(path, value):
        return "failed-or-incomplete"
    return "legacy-schema-incomplete"


def inventory(evidence_root: Path, retained: set[str], exclusions: Sequence[str] = ()) -> dict[str, Any]:
    records = []
    passing = 0
    eligible = 0
    counts: Counter[str] = Counter()
    for path in sorted(evidence_root.rglob("*.json")):
        relative = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else f"evidence/{path.relative_to(evidence_root).as_posix()}"
        if any(relative == prefix or relative.startswith(prefix + "/") for prefix in exclusions):
            continue
        raw = path.read_bytes()
        try:
            value = json.loads(raw)
            disposition = classify(relative, value, retained) if isinstance(value, Mapping) else "legacy-schema-incomplete"
        except (json.JSONDecodeError, UnicodeDecodeError):
            # Preserve malformed/incomplete files in the inventory and its
            # digest. They are failed inputs, never passing prerequisites.
            value = None
            disposition = "failed-or-incomplete"
        counts[disposition] += 1
        if isinstance(value, Mapping) and historically_passing(value):
            passing += 1
        if disposition == "current-feature-evidence":
            eligible += 1
        records.append({"path": relative, "digest": digest_bytes(raw), "disposition": disposition})
    return {
        "jsonFileCount": len(records),
        "historicallyPassingCount": passing,
        "featureAcceptanceEligibleCount": eligible,
        "inventoryDigest": digest_bytes(canonical_bytes(records)),
        "dispositionCounts": dict(sorted(counts.items())),
    }


def validate(policy_path: Path = POLICY, *, evidence_root: Path = EVIDENCE_ROOT) -> dict[str, Any]:
    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    expected_fields = {
        "schemaVersion", "auditId", "auditedThrough", "evidenceRoot", "currentEvidenceExclusions", "featureEvidenceSchema",
        "productAcceptancePolicy", "retainedPrerequisites", "disqualificationRules", "inventorySnapshot",
    }
    require(set(policy) == expected_fields, "historical evidence audit fields drifted")
    require(policy["schemaVersion"] == 1 and policy["auditId"] == "teamaibox.historical-evidence-audit.v1",
            "historical evidence audit identity drifted")
    require(policy["evidenceRoot"] == "evidence", "historical evidence root drifted")
    exclusions = policy["currentEvidenceExclusions"]
    require(exclusions == ["evidence/validation/feature-deployments", "evidence/validation/features", "evidence/validation/browser/features", "evidence/validation/protocol/features", "evidence/platform/web-spark-authenticated-deployment-auth-worker02-20260812-a20.json", "evidence/platform/web-spark-authenticated-deployment-auth-worker02-20260812-a21.json"],
            "current evidence exclusion boundary drifted")
    require(policy["featureEvidenceSchema"] == "architecture/validation/feature-evidence-schema.v1.json"
            and (ROOT / policy["featureEvidenceSchema"]).is_file(), "current feature evidence schema is unbound")
    require("Only evidence that passes" in policy["productAcceptancePolicy"], "product acceptance policy is weakened")
    retained_values = policy["retainedPrerequisites"]
    require(isinstance(retained_values, list) and retained_values, "retained prerequisite list is empty")
    retained: set[str] = set()
    for item in retained_values:
        require(isinstance(item, Mapping) and set(item) == {"path", "use"}, "retained prerequisite fields drifted")
        require(isinstance(item["path"], str) and item["path"].startswith("evidence/") and item["path"] not in retained,
                "retained prerequisite path is invalid or duplicated")
        require((ROOT / item["path"]).is_file(), f"retained prerequisite is missing: {item['path']}")
        require(item["use"] in {"hardware-prerequisite", "model-prerequisite", "component-prerequisite",
                                "disposable-hardware-prerequisite", "negative-gate-evidence"},
                f"retained prerequisite use is invalid: {item['path']}")
        retained.add(item["path"])
    rules = policy["disqualificationRules"]
    require(isinstance(rules, list), "disqualification rules must be a list")
    rule_codes = [item.get("code") for item in rules if isinstance(item, Mapping)]
    expected_codes = [
        "stale-preview", "static-fixture", "synthetic-service-objective", "contract-only-provider",
        "memory-repository", "failed-or-incomplete", "legacy-schema-incomplete", "retained-prerequisite-only",
    ]
    require(rule_codes == expected_codes, "historical disqualification rule coverage drifted")
    require(all(set(item) == {"code", "reason"} and isinstance(item["reason"], str) and len(item["reason"]) >= 60
                for item in rules), "historical disqualification reasons are incomplete")
    actual = inventory(evidence_root, retained, exclusions)
    require(actual == policy["inventorySnapshot"], "historical evidence inventory changed or was not fully audited")
    for code in expected_codes:
        require(actual["dispositionCounts"].get(code, 0) > 0, f"historical audit has no classified {code} evidence")
    require(actual["featureAcceptanceEligibleCount"] == 0,
            "legacy audit unexpectedly found current feature evidence; validate and bind it separately")
    return {"valid": True, "auditId": policy["auditId"], **actual, "retainedPrerequisiteCount": len(retained)}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, default=POLICY)
    parser.add_argument("--evidence-root", type=Path, default=EVIDENCE_ROOT)
    parser.add_argument("--print-snapshot", action="store_true")
    args = parser.parse_args(argv)
    if args.print_snapshot:
        policy = json.loads(args.policy.read_text(encoding="utf-8"))
        retained = {item["path"] for item in policy["retainedPrerequisites"]}
        print(json.dumps(inventory(args.evidence_root.resolve(), retained, policy["currentEvidenceExclusions"]), indent=2, sort_keys=True))
        return 0
    result = validate(args.policy.resolve(), evidence_root=args.evidence_root.resolve())
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (HistoricalEvidenceAuditError, json.JSONDecodeError, OSError) as error:
        print(f"historical evidence audit invalid: {error}")
        raise SystemExit(1)
