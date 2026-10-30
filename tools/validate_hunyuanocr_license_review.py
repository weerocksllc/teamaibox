#!/usr/bin/env python3
"""Validate the fail-closed HunyuanOCR license-review packet."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
REVIEW = ROOT / "architecture/validation/hunyuanocr-license-review.v1.json"
PROFILE = ROOT / "deploy/application-catalog-e2e/ocr-hunyuan-managed-profile.validating.v2.json"
SHA256 = re.compile(r"sha256:[a-f0-9]{64}")
REVISION = "01b3ec869d704307645d2d8667f01c5bec6fef6d"
PROFILE_KEY = "ocr.hunyuanocr-1.5.bf16-dflash.spark-managed.v2"
LICENSE_DIGEST = "sha256:745adaa59575d2a98b64fd6d3452537b477a6b6edc126f742fc055313cc3d3e0"
REQUIRED_DECISIONS = {
    "deployment-and-customer-territories",
    "appliance-and-offline-package-distribution-classification",
    "license-copy-and-notice-delivery",
    "modified-file-notices",
    "provider-identity-and-tencent-non-affiliation-disclosure",
    "section-5-use-restrictions-in-product-terms",
    "acceptable-use-policy-enforcement",
    "prohibition-on-improving-non-hunyuan-ai-models-with-outputs",
    "public-machine-generated-content-disclosure",
    "monthly-active-user-threshold",
    "termination-removal-and-customer-update-procedure",
    "indemnity-warranty-and-jurisdiction-risk",
}


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def validate(path: Path = REVIEW) -> dict[str, Any]:
    review = json.loads(path.read_text(encoding="utf-8"))
    profile = json.loads(PROFILE.read_text(encoding="utf-8"))

    if review.get("schemaVersion") != 1 or review.get("reviewId") != "teamaibox.hunyuanocr-1.5-license-review.v1":
        raise ValueError("HunyuanOCR license-review identity drifted")
    subject = review.get("subject")
    if not isinstance(subject, Mapping) or subject.get("model") != "tencent/HunyuanOCR" or subject.get("revision") != REVISION:
        raise ValueError("HunyuanOCR license-review subject drifted")
    if subject.get("profileKey") != PROFILE_KEY or subject.get("profileId") != profile.get("profileId") or subject.get("includesDflashDraft") is not True:
        raise ValueError("HunyuanOCR target/DFlash profile binding is incomplete")

    license_record = review.get("license")
    profile_license = profile.get("source", {}).get("license", {})
    if not isinstance(license_record, Mapping) or license_record.get("textDigest") != LICENSE_DIGEST or SHA256.fullmatch(str(license_record.get("textDigest"))) is None:
        raise ValueError("HunyuanOCR pinned license digest drifted")
    if profile.get("source", {}).get("revision") != REVISION or profile_license.get("textDigest") != LICENSE_DIGEST:
        raise ValueError("HunyuanOCR model profile does not bind the reviewed license")
    if license_record.get("sourceUrl") != profile_license.get("evidenceRef"):
        raise ValueError("HunyuanOCR license source and model profile disagree")
    if license_record.get("dflashCoverageSourceUrl") != f"https://huggingface.co/tencent/HunyuanOCR/blob/{REVISION}/dflash/README.md":
        raise ValueError("HunyuanOCR DFlash license coverage source drifted")

    intended = review.get("intendedProductUse")
    if not isinstance(intended, Mapping) or intended.get("currentMode") != "experimental-development-only":
        raise ValueError("HunyuanOCR pending use is not restricted to development")
    if intended.get("certifiedRouteEligible") is not False or intended.get("releaseDistributionEligible") is not False:
        raise ValueError("HunyuanOCR pending review improperly enables production")
    if set(review.get("requiredReviewDecisions", [])) != REQUIRED_DECISIONS:
        raise ValueError("HunyuanOCR human legal decision checklist is incomplete")

    findings = review.get("sourceFindings")
    if not isinstance(findings, Mapping) or set(findings.get("territoryExcludes", [])) != {"European Union", "United Kingdom", "South Korea"}:
        raise ValueError("HunyuanOCR territory finding is incomplete")
    required_true = {
        "thirdPartyDistributionRequiresLicenseCopy",
        "nonHostedDistributionRequiresNoticeFile",
        "modifiedFilesRequireProminentChangeNotice",
        "endUsersRequireProviderIdentityAndNonAffiliationDisclosure",
        "sections5aAnd5bMustBePassedThrough",
        "outputsMayNotImproveNonHunyuanModels",
        "terminationRequiresCeaseUseAndDeletion",
    }
    if any(findings.get(key) is not True for key in required_true) or findings.get("additionalLicenseThresholdMonthlyActiveUsers") != 100_000_000:
        raise ValueError("HunyuanOCR source findings are incomplete")

    artifacts = review.get("releaseArtifacts")
    if not isinstance(artifacts, Mapping):
        raise ValueError("HunyuanOCR release artifact map is missing")
    for key in ("checklist", "noticeTemplate", "modelProfile"):
        artifact = ROOT / str(artifacts.get(key, ""))
        if not artifact.is_file() or ROOT not in artifact.resolve().parents:
            raise ValueError(f"HunyuanOCR release artifact {key} is missing")
    checklist = (ROOT / artifacts["checklist"]).read_text(encoding="utf-8")
    for phrase in ("not legal advice", "Territory", "Distribution", "Fail-closed rule", "pending"):
        if phrase not in checklist:
            raise ValueError(f"HunyuanOCR checklist omits {phrase}")
    notice = (ROOT / artifacts["noticeTemplate"]).read_text(encoding="utf-8").strip()
    if not notice.startswith("Tencent Hunyuan is licensed under") or "Copyright © 2025 Tencent" not in notice:
        raise ValueError("HunyuanOCR NOTICE template drifted")

    decision = review.get("decision")
    if not isinstance(decision, Mapping) or decision.get("status") != "pending-human-legal-review":
        raise ValueError("HunyuanOCR review is not pending accountable human approval")
    if decision.get("reviewerAttestation") is not None or any(decision.get(key) is not False for key in ("licenseApproved", "certificationApproved", "releaseDistributionApproved")):
        raise ValueError("HunyuanOCR pending review contains an approval")
    gate = review.get("failClosed")
    if not isinstance(gate, Mapping) or gate.get("experimentalDevelopmentAllowed") is not True:
        raise ValueError("HunyuanOCR Experimental development boundary is missing")
    if any(gate.get(key) is not True for key in ("productionCertificationBlocked", "certifiedOnlyRoutingBlocked", "shippingModelWeightsBlocked")):
        raise ValueError("HunyuanOCR release gate is not fail closed")

    return {
        "valid": True,
        "reviewId": review["reviewId"],
        "licenseDigest": LICENSE_DIGEST,
        "licenseApproved": False,
        "certificationApproved": False,
        "releaseDistributionApproved": False,
        "task18_6Complete": False,
        "packetDigest": digest_bytes(path.read_bytes()),
        "requiredDecisionCount": len(REQUIRED_DECISIONS),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review", type=Path, default=REVIEW)
    args = parser.parse_args()
    print(json.dumps(validate(args.review), sort_keys=True, separators=(",", ":")))
