#!/usr/bin/env python3
"""Strictly validate the digest-bound HunyuanOCR license approval successor."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
APPROVAL = ROOT / "architecture/validation/hunyuanocr-license-review.v2.json"
PENDING = ROOT / "architecture/validation/hunyuanocr-license-review.v1.json"
PROFILE = ROOT / "deploy/application-catalog-e2e/ocr-hunyuan-managed-profile.validating.v2.json"
CHECKLIST = ROOT / "docs/operations/hunyuanocr-license-review-checklist.md"
NOTICE = ROOT / "deploy/legal/hunyuanocr/NOTICE.template.txt"
REVISION = "01b3ec869d704307645d2d8667f01c5bec6fef6d"
LICENSE_DIGEST = "sha256:745adaa59575d2a98b64fd6d3452537b477a6b6edc126f742fc055313cc3d3e0"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def require(value: bool, message: str) -> None:
    if not value:
        raise ValueError(message)


def validate(path: Path = APPROVAL) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    pending = json.loads(PENDING.read_text(encoding="utf-8"))
    profile = json.loads(PROFILE.read_text(encoding="utf-8"))

    require(value.get("schemaVersion") == 1 and value.get("reviewId") == "teamaibox.hunyuanocr-1.5-license-review.v2",
            "HunyuanOCR approval identity drifted")
    predecessor = value.get("supersedes")
    require(isinstance(predecessor, Mapping)
            and predecessor.get("path") == PENDING.relative_to(ROOT).as_posix()
            and predecessor.get("reviewId") == pending.get("reviewId")
            and predecessor.get("fileSha256") == digest(PENDING),
            "HunyuanOCR pending-review predecessor drifted")

    subject = value.get("subject")
    require(isinstance(subject, Mapping)
            and subject.get("model") == "tencent/HunyuanOCR"
            and subject.get("revision") == REVISION
            and subject.get("profileKey") == profile.get("profileKey")
            and subject.get("profileId") == profile.get("profileId")
            and subject.get("includesDflashDraft") is True
            and subject.get("profileFileSha256") == digest(PROFILE),
            "HunyuanOCR approval subject drifted")

    license_record = value.get("license")
    require(isinstance(license_record, Mapping)
            and license_record.get("textDigest") == LICENSE_DIGEST
            and SHA256.fullmatch(str(license_record.get("textDigest", ""))) is not None
            and license_record.get("sourceUrl") == profile.get("source", {}).get("license", {}).get("evidenceRef")
            and license_record.get("dflashCoverageSourceUrl")
                == f"https://huggingface.co/tencent/HunyuanOCR/blob/{REVISION}/dflash/README.md",
            "HunyuanOCR approval license binding drifted")

    use = value.get("approvedUse")
    territory = use.get("territoryPolicy", {}) if isinstance(use, Mapping) else {}
    require(isinstance(use, Mapping)
            and use.get("customerOperatedApplianceWithPreinstalledWeights") is True
            and use.get("onPremisesBrowserHostedService") is True
            and use.get("offlineModelPackageDistribution") is True
            and use.get("modelOutputExport") is True
            and territory.get("allowed") == "license-territory-only"
            and set(territory.get("excluded", [])) == {"European Union", "United Kingdom", "South Korea"}
            and territory.get("failClosedOutsideAllowedTerritory") is True,
            "HunyuanOCR approved use or territory policy is incomplete")
    conditions = use.get("distributionConditions", {})
    require(isinstance(conditions, Mapping) and conditions
            and all(item is True for item in conditions.values()),
            "HunyuanOCR distribution conditions are not fully accepted")

    artifacts = value.get("releaseArtifacts")
    require(isinstance(artifacts, Mapping), "HunyuanOCR approval artifacts are missing")
    expected = {"checklist": CHECKLIST, "noticeTemplate": NOTICE}
    for key, target in expected.items():
        record = artifacts.get(key)
        require(isinstance(record, Mapping)
                and record.get("path") == target.relative_to(ROOT).as_posix()
                and record.get("fileSha256") == digest(target),
                f"HunyuanOCR approval artifact drifted: {key}")

    decision = value.get("decision")
    attestation = decision.get("reviewerAttestation", {}) if isinstance(decision, Mapping) else {}
    require(isinstance(decision, Mapping)
            and decision.get("status") == "approved-with-conditions"
            and decision.get("licenseApproved") is True
            and decision.get("certificationLicenseGateApproved") is True
            and decision.get("releaseDistributionApproved") is True
            and isinstance(attestation, Mapping)
            and attestation.get("reviewerId") == "team-ai-box-project-owner"
            and attestation.get("reviewerRole") == "accountable-product-owner"
            and attestation.get("decisionSource") == "explicit-user-confirmation-in-project-thread"
            and all(attestation.get(key) is True for key in (
                "attestedExactSubject", "attestedAllRequiredDecisions", "acceptedConditions")),
            "HunyuanOCR accountable approval attestation is incomplete")

    gates = value.get("remainingTechnicalGates")
    require(isinstance(gates, Mapping)
            and gates.get("releaseCandidateSoakRequired") is True
            and gates.get("profileCertificationPending") is True
            and gates.get("certifiedOnlyRoutingBlocked") is True
            and gates.get("shippingModelWeightsBlockedUntilAllTechnicalGatesPass") is True
            and gates.get("task18_6Complete") is False,
            "HunyuanOCR approval improperly waives a technical release gate")

    return {
        "valid": True,
        "reviewId": value["reviewId"],
        "licenseDigest": LICENSE_DIGEST,
        "licenseApproved": True,
        "certificationLicenseGateApproved": True,
        "releaseDistributionApproved": True,
        "releaseCandidateSoakRequired": True,
        "task18_6Complete": False,
        "approvalFileSha256": digest(path),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--approval", type=Path, default=APPROVAL)
    args = parser.parse_args()
    print(json.dumps(validate(args.approval), sort_keys=True, separators=(",", ":")))
