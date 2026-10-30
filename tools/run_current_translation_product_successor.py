#!/usr/bin/env python3
"""Promote the exact current Translation slice to automated Product Accepted scope."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
from typing import Any, Sequence

try:
    from .run_spark_model_baseline import canonical_digest, utc_now
except ImportError:
    from run_spark_model_baseline import canonical_digest, utc_now


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_ROOT = ROOT / "evidence/validation/acceptance"
RUN_ID = re.compile(r"^current-translation-product-successor-[0-9]{8}-a[1-9][0-9]*$")
PARENT = EVIDENCE_ROOT / "current-translation-composition-closure-20260830-a1.json"
PARENT_RUNNER = "teamaibox.current-translation-composition-closure.v1"
PARENT_RUN_ID = "current-translation-composition-closure-20260830-a1"
COMMANDS = (
    ("python3", "tools/validate_current_translation_composition_closure.py", "--evidence",
     PARENT.relative_to(ROOT).as_posix()),
    ("python3", "-m", "unittest", "tests.test_current_translation_product_successor"),
)
SOURCES = (
    "tools/run_current_translation_product_successor.py",
    "tools/validate_current_translation_product_successor.py",
    "tests/test_current_translation_product_successor.py",
)


class QualificationFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise QualificationFailure(message)


def digest(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def bind_parent() -> tuple[dict[str, Any], dict[str, str]]:
    raw = PARENT.read_bytes()
    value = json.loads(raw)
    require(value.get("runnerId") == PARENT_RUNNER
            and value.get("runId") == PARENT_RUN_ID
            and value.get("status") == "passed" and value.get("failure") is None
            and value.get("featureKey") == "official.translation"
            and value.get("task") == "18.8"
            and value.get("claimBoundary") == {
                "componentReady": True,
                "independentHumanAcceptance": False,
                "productAccepted": False,
                "releaseSoakComplete": False,
                "task18_8Complete": True,
                "translationProfileCertification": "experimental",
            }
            and value.get("evidenceDigest") == canonical_digest(
                {key: item for key, item in value.items() if key != "evidenceDigest"}),
            "Translation composition parent drifted")
    return value, {
        "path": PARENT.relative_to(ROOT).as_posix(),
        "runnerId": PARENT_RUNNER,
        "runId": PARENT_RUN_ID,
        "evidenceDigest": value["evidenceDigest"],
        "fileSha256": digest(raw),
    }


def execute(argv: Sequence[str]) -> dict[str, Any]:
    started = time.monotonic()
    completed = subprocess.run(list(argv), cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=2400, check=False)
    return {
        "argvDigest": digest(json.dumps(list(argv), separators=(",", ":")).encode()),
        "exitCode": completed.returncode,
        "durationMilliseconds": int((time.monotonic() - started) * 1000),
        "stdoutDigest": digest(completed.stdout),
        "stderrDigest": digest(completed.stderr),
        "outputRetained": False,
    }


def build(run_id: str) -> tuple[dict[str, Any], bool]:
    require(RUN_ID.fullmatch(run_id) is not None, "Translation product successor run ID is invalid")
    _, parent = bind_parent()
    commands = [execute(argv) for argv in COMMANDS]
    passed = all(item["exitCode"] == 0 for item in commands)
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "runnerId": "teamaibox.current-translation-product-successor.v1",
        "runId": run_id,
        "status": "passed" if passed else "failed",
        "startedAt": utc_now(),
        "completedAt": utc_now(),
        "features": ["official.translation", "compute.translation"],
        "ownerTaskId": "18.8",
        "parent": parent,
        "profile": {
            "certificationState": "experimental",
            "experimentalDisclosureRequired": True,
            "selectedCertifiedProfileClaimed": False,
            "releaseCandidateSoakComplete": False,
        },
        "acceptance": {
            "currentApplicationAndComputeAvailable": passed,
            "textImageAudioVideoComposition": passed,
            "capacityFailureCancellationPermission": passed,
            "encryptedPersistenceAndRestart": passed,
            "systemTrustedBrowser": passed,
        },
        "validationCommands": commands,
        "sources": [{"path": path, "sha256": digest((ROOT / path).read_bytes())} for path in SOURCES],
        "privacy": {"credentialsRetained": False, "userContentRetained": False,
                    "commandOutputRetained": False},
        "claimBoundary": {
            "productAccepted": passed,
            "enabledInSupportedRelease": passed,
            "experimentalProfileDisclosed": True,
            "certifiedProfileClaimed": False,
            "releaseCandidateSoakComplete": False,
            "stageReleaseAccepted": False,
            "independentHumanAcceptanceDeferred": True,
        },
        "limitations": [
            "Automated Product Accepted covers the current installed Translation application and compute path with an explicit Experimental profile label.",
            "It does not certify the Translation model profile or satisfy a later selected-profile release-candidate soak.",
            "Independent administrator/member acceptance remains scoped to stage release or formal delivery.",
        ],
        "failure": None if passed else {
            "failedCommandIndexes": [index for index, item in enumerate(commands) if item["exitCode"] != 0],
            "outputRetained": False,
        },
    }
    report["evidenceDigest"] = canonical_digest(report)
    return report, passed


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)
    output = EVIDENCE_ROOT / f"{args.run_id}.json"
    require(not output.exists(), "Translation product successor evidence already exists")
    report, passed = build(args.run_id)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    require(passed, f"Translation product successor failed; evidence: {output.relative_to(ROOT)}")
    print(json.dumps({"runId": args.run_id, "status": "passed", "productAccepted": True,
                      "evidence": output.relative_to(ROOT).as_posix()}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (QualificationFailure, OSError, ValueError, KeyError, json.JSONDecodeError,
            subprocess.TimeoutExpired) as error:
        raise SystemExit(f"Translation product successor failed: {error}")
