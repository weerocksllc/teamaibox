#!/usr/bin/env python3
"""Validate exact fail-closed Translation quality evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re


SHA = re.compile(r"^sha256:[a-f0-9]{64}$")
EXPECTED = {
    "runId": "translation-quality-20260813-madlad400-bf16-a2",
    "corpusDigest": "sha256:2719fa2f632a787fa718f53da06e48c50043d951fd9e1d5f8f9e44ae2be16d08",
    "candidateProfileFingerprint": "sha256:faf67c329e8a4f3bdfe257a580169004fa06e0b07bea30ab4859a1d970e3fdbe",
    "baselineProfileFingerprint": "sha256:e6dddee0e8b22a27867cdc10860b1a08667d5ccfcf0e21f6e23b32e7c83813b7",
    "candidateResultDigest": "sha256:daa690f15b0f0812cdf59bc46d6d00f05806470b39169af7da572b94a4684782",
    "baselineResultDigest": "sha256:ee5e75c397e3c26a287a356652d18ae264fd925988f429ab19301c3529c0a467",
    "metricResultDigest": "sha256:26dfecf80efc66f56939c6a2f136edff0957d9e6641d4185bd615e905eac6e06",
}


def canonical_digest(value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def validate(evidence: dict[str, object]) -> None:
    payload = dict(evidence)
    claimed = payload.pop("evidenceDigest", None)
    require(SHA.fullmatch(str(claimed)) is not None and claimed == canonical_digest(payload), "quality evidence digest drifted")
    require(evidence.get("schemaVersion") == 1 and evidence.get("runId") == EXPECTED["runId"], "quality run identity drifted")
    require(evidence.get("target") == "dgx-spark-dev-01", "quality target drifted")
    inputs = evidence.get("inputEvidence") or {}
    for key, expected in EXPECTED.items():
        if key != "runId":
            require(inputs.get(key) == expected, f"quality input {key} drifted")
    report = evidence.get("suiteReport") or {}
    require(report.get("suiteKey") == "quality.translation.multilingual" and report.get("suiteVersion") == "1.0.0", "quality suite drifted")
    require(report.get("corpusDigest") == inputs.get("corpusDigest"), "quality corpus binding drifted")
    require(report.get("profileFingerprint") == inputs.get("candidateProfileFingerprint"), "quality candidate binding drifted")
    require(report.get("baselineProfileFingerprint") == inputs.get("baselineProfileFingerprint"), "quality baseline binding drifted")
    require(report.get("caseCount") == 500 and len(report.get("measurements") or []) == 11, "quality result coverage drifted")
    require(report.get("outcome") == "failed" and len(report.get("failures") or []) == 7, "quality fail-closed outcome drifted")
    require(evidence.get("certificationClaimEligible") is False, "failed quality evidence became certification eligible")
    require(evidence.get("plaintextCasesRetained") is False and evidence.get("credentialsRetained") is False, "quality privacy facts drifted")
    report_payload = {key: value for key, value in report.items() if key != "reportDigest"}
    require(report.get("reportDigest") == canonical_digest(report_payload), "quality suite report digest drifted")
    expected_failures = {
        ("chrf-score", "en-zh"), ("chrf-score", "long-tail"),
        ("comet-score", "en-zh"), ("comet-score", "long-tail"),
        ("numeric-entity-preservation", "en-zh"),
        ("numeric-entity-preservation", "long-tail"),
        ("numeric-entity-preservation", "zh-en"),
    }
    require({(item.get("metricKey"), item.get("sliceKey")) for item in report["failures"]} == expected_failures,
            "quality failure set drifted")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    validate(json.loads(args.evidence.read_text(encoding="utf-8")))
    print(json.dumps({"outcome": "passed", "validatedOutcome": "failed", "evidence": str(args.evidence)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
