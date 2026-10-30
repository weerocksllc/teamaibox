#!/usr/bin/env python3
"""Validate that active-media LUKS migration remains human-reviewed and blocked."""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "deploy/maintenance/luks/production-migration-review.v1.json"
SHA256 = re.compile(r"sha256:[a-f0-9]{64}")
SAFE_REVIEWER_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}")
UTC_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z")


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def review_policy_digest(policy: Mapping[str, Any]) -> str:
    material = {
        "policyId": policy.get("policyId"),
        "runbook": policy.get("runbook"),
        "scope": policy.get("scope"),
        "humanReviewRequired": policy.get("humanReviewRequired"),
        "requiredApprovals": policy.get("requiredApprovals"),
        "requiredEvidence": policy.get("requiredEvidence"),
        "forbiddenTargets": policy.get("forbiddenTargets"),
        "developmentSparkApproved": policy.get("developmentSparkApproved"),
    }
    encoded = json.dumps(material, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return digest_bytes(encoded)


def validate(path: Path = POLICY, *, reviewed: bool = False) -> dict[str, object]:
    policy = json.loads(path.read_text(encoding="utf-8"))
    if policy.get("schemaVersion") != 1 or policy.get("policyId") != "maintenance.luks2-production-migration.v1": raise ValueError("LUKS migration review policy identity drifted")
    if policy.get("executionAllowed") is not False or policy.get("humanReviewRequired") is not True or policy.get("approval") is not None: raise ValueError("generic runbook review improperly authorizes a migration")
    if policy.get("developmentSparkApproved") is not False: raise ValueError("development Spark was approved for migration")
    approvals = set(policy.get("requiredApprovals", []))
    if approvals != {"migration_owner", "independent_reviewer", "backup_restore_operator", "console_recovery_operator"}: raise ValueError("LUKS migration approval roles are incomplete")
    evidence = set(policy.get("requiredEvidence", []))
    if len(evidence) != 9 or not {"independent_backup_manifest", "restore_rehearsal", "offline_recovery_factor_test", "luks_header_backup", "boot_recovery_media_test", "rollback_rehearsal"} <= evidence: raise ValueError("LUKS migration evidence gate is incomplete")
    forbidden = set(policy.get("forbiddenTargets", []))
    if not {"active_root", "efi", "boot", "recovery", "swap", "unresolved_device_path", "sole_data_copy"} <= forbidden: raise ValueError("LUKS migration target fence is incomplete")
    runbook = ROOT / policy.get("runbook", "")
    if not runbook.is_file() or ROOT not in runbook.resolve().parents: raise ValueError("LUKS migration runbook is missing")
    text = runbook.read_text(encoding="utf-8")
    for phrase in ("Non-negotiable stop conditions", "Required independent data copy and recovery rehearsal", "Power loss and interruption matrix", "Rollback", "independent human review", "must never auto-select another device"):
        if phrase not in text: raise ValueError(f"LUKS migration runbook omits {phrase}")
    if "/dev/nvme0n1" in text: raise ValueError("generic runbook hard-codes an NVMe target")
    review_status = policy.get("reviewStatus")
    review = policy.get("runbookReview")
    if review_status == "pending":
        if review is not None: raise ValueError("pending LUKS runbook contains a review attestation")
    elif review_status == "approved":
        if not isinstance(review, Mapping) or set(review) != {"reviewerId", "role", "decision", "reviewedAt", "runbookDigest", "reviewPolicyDigest"}: raise ValueError("LUKS runbook review attestation is incomplete")
        if SAFE_REVIEWER_ID.fullmatch(str(review.get("reviewerId"))) is None or review.get("role") != "independent_reviewer" or review.get("decision") != "approved": raise ValueError("LUKS runbook review identity or decision is invalid")
        if UTC_TIMESTAMP.fullmatch(str(review.get("reviewedAt"))) is None: raise ValueError("LUKS runbook review time is not UTC")
        datetime.fromisoformat(review["reviewedAt"].replace("Z", "+00:00"))
        if review.get("runbookDigest") != digest_bytes(runbook.read_bytes()) or SHA256.fullmatch(str(review.get("runbookDigest"))) is None: raise ValueError("LUKS runbook review digest is invalid")
        if review.get("reviewPolicyDigest") != review_policy_digest(policy): raise ValueError("LUKS runbook review policy digest is invalid")
    else:
        raise ValueError("LUKS runbook review status is invalid")
    if reviewed and review_status != "approved": raise ValueError("LUKS migration runbook has not received independent human review")
    return {"valid": True, "executionAllowed": False, "reviewStatus": review_status, "requiredEvidenceCount": len(evidence)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reviewed", action="store_true", help="require a digest-bound independent human runbook review")
    parser.add_argument("--review-digests", action="store_true", help="print the exact runbook and policy digests to review")
    args = parser.parse_args()
    if args.review_digests:
        policy = json.loads(POLICY.read_text(encoding="utf-8"))
        runbook = ROOT / policy["runbook"]
        print(json.dumps({"runbookDigest": digest_bytes(runbook.read_bytes()), "reviewPolicyDigest": review_policy_digest(policy)}, sort_keys=True, separators=(",", ":")))
    else:
        print(json.dumps(validate(reviewed=args.reviewed), sort_keys=True, separators=(",", ":")))
