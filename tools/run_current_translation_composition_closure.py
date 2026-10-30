#!/usr/bin/env python3
"""Aggregate exact Translation composition and capacity evidence for task 18.8."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from typing import Any, Sequence

try:
    from .run_spark_model_baseline import canonical_digest, utc_now
except ImportError:
    from run_spark_model_baseline import canonical_digest, utc_now


ROOT = Path(__file__).resolve().parents[1]
RUN_ID = re.compile(r"^current-translation-composition-closure-[0-9]{8}-a[1-9][0-9]*$")
SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
PARENTS = {
    "development": ROOT / "evidence/validation/acceptance/current-translation-development-closure-20260830-a1.json",
    "capacity": ROOT / "evidence/validation/acceptance/current-translation-capacity-20260830-a4.json",
}
VALIDATIONS = (
    ("development", "tools/validate_current_translation_development_closure.py"),
    ("capacity", "tools/validate_current_translation_capacity_acceptance.py"),
)
RUNNER = ROOT / "tools/run_current_translation_composition_closure.py"
VALIDATOR = ROOT / "tools/validate_current_translation_composition_closure.py"
TEST = ROOT / "tests/test_current_translation_composition_closure.py"


class ClosureError(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise ClosureError(message)


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def parent(path: Path) -> dict[str, Any]:
    value = load(path); payload = dict(value); claimed = payload.pop("evidenceDigest", None)
    require(SHA256.fullmatch(str(claimed or "")) is not None and claimed == canonical_digest(payload)
            and value.get("status") == "passed" and value.get("failure") is None,
            "Translation composition closure parent drifted: " + path.name)
    return {"path": path.relative_to(ROOT).as_posix(), "sha256": digest(path), "runId": value.get("runId"),
            "runnerId": value.get("runnerId"), "evidenceDigest": claimed}


def source(path: Path) -> dict[str, str]:
    require(path.is_file(), "Translation composition closure source is missing")
    return {"path": path.relative_to(ROOT).as_posix(), "sha256": digest(path)}


def coverage() -> dict[str, bool]:
    development = load(PARENTS["development"]); capacity = load(PARENTS["capacity"])
    base = development.get("coverage", {}); operations = capacity.get("operations", {})
    return {
        "applicationAndWorkersDeployed": base.get("containerDeployment") is True,
        "textComposition": base.get("textTranslation") is True,
        "imageOcrComposition": base.get("imageOcrTranslation") is True,
        "audioAsrComposition": base.get("audioAsrTranslation") is True,
        "videoSubtitleComposition": base.get("videoSubtitleTranslation") is True,
        "intermediateProvenance": base.get("ocrIntermediate") is True and base.get("asrIntermediate") is True,
        "alignedResultAndExport": base.get("alignedResult") is True and base.get("webVttExport") is True,
        "capacityBoundary": operations.get("capacityRejectedWith429") is True
            and operations.get("retryAfterCapacityReleaseSucceeded") is True,
        "errorBoundary": base.get("errorBoundary") is True,
        "cancellation": base.get("cancellation") is True,
        "permissionBoundary": base.get("permissionDenial") is True,
        "restartPersistence": base.get("restartPersistence") is True,
        "encryptedResults": base.get("encryptedOutputs") is True and operations.get("allJobsSucceeded") is True,
        "trustedBrowser": base.get("trustedBrowser") is True,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--run-id", required=True)
    run_id = parser.parse_args(argv).run_id
    require(RUN_ID.fullmatch(run_id) is not None, "unsafe Translation composition closure identity")
    output = ROOT / f"evidence/validation/acceptance/{run_id}.json"
    require(not output.exists(), "immutable Translation composition closure evidence exists")
    for path in (RUNNER, VALIDATOR, TEST, *PARENTS.values()): require(path.is_file(), "Translation composition closure input is missing")
    commands = []
    for key, validator in VALIDATIONS:
        completed = subprocess.run(["python3", validator, "--evidence", str(PARENTS[key])], cwd=ROOT,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=2400, check=False)
        require(completed.returncode == 0, "Translation composition closure parent failed: " + key)
        commands.append({"parent": key, "validator": validator, "exitCode": 0, "outputRetained": False})
    focused = subprocess.run(["python3", "-m", "unittest", "tests/test_current_translation_composition_closure.py"],
                             cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False)
    require(focused.returncode == 0, "Translation composition closure tests failed")
    matrix = coverage(); require(len(matrix) == 14 and all(matrix.values()), "Translation composition coverage is incomplete")
    report: dict[str, Any] = {
        "schemaVersion": 1, "runnerId": "teamaibox.current-translation-composition-closure.v1",
        "runId": run_id, "status": "passed", "startedAt": utc_now(), "completedAt": utc_now(),
        "featureKey": "official.translation", "task": "18.8",
        "parents": {key: parent(path) for key, path in PARENTS.items()},
        "sources": [source(RUNNER), source(VALIDATOR), source(TEST)],
        "sourceTests": {"passed": True, "focusedPythonTests": 3, "outputRetained": False},
        "validationCommands": commands, "coverage": matrix,
        "claimBoundary": {"task18_8Complete": True, "componentReady": True,
                          "translationProfileCertification": "experimental", "releaseSoakComplete": False,
                          "independentHumanAcceptance": False, "productAccepted": False},
        "remainingReleaseGates": ["selected Certified Translation profile qualification/soak",
                                  "formal-release administrator/member acceptance"],
        "privacy": {"credentialsRetained": False, "userContentRetained": False,
                    "commandOutputRetained": False, "syntheticScreenshotsRetained": True},
        "failure": None,
    }
    report["evidenceDigest"] = canonical_digest(report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"runId": run_id, "status": "passed", "task18_8Complete": True,
                      "evidence": output.relative_to(ROOT).as_posix(), "evidenceDigest": report["evidenceDigest"]}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ClosureError, OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
        raise SystemExit("current Translation composition closure failed: " + str(error))
