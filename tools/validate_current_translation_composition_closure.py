#!/usr/bin/env python3
"""Strictly validate the exact Translation composition closure."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
from typing import Any, Sequence

try:
    from .run_current_translation_composition_closure import (
        PARENTS, ROOT, RUN_ID, RUNNER, SHA256, TEST, VALIDATIONS, VALIDATOR, coverage, parent, source,
    )
    from .run_spark_model_baseline import canonical_digest
except ImportError:
    from run_current_translation_composition_closure import (
        PARENTS, ROOT, RUN_ID, RUNNER, SHA256, TEST, VALIDATIONS, VALIDATOR, coverage, parent, source,
    )
    from run_spark_model_baseline import canonical_digest


class ValidationError(RuntimeError):
    pass


SENSITIVE = re.compile(r'(?i)(bearer\s+[A-Za-z0-9._~+/=-]{12,}|"(?:password|secret|token|credential|cookie)"\s*:\s*"(?!\[REDACTED\])[^"\r\n]{8,}")')


def require(value: bool, message: str) -> None:
    if not value:
        raise ValidationError(message)


def validate(path: Path) -> dict[str, Any]:
    resolved = path.resolve(); require(resolved.is_file() and resolved.parent == (ROOT / "evidence/validation/acceptance").resolve(), "Translation composition closure evidence is unscoped")
    raw = resolved.read_text(encoding="utf-8"); value = json.loads(raw)
    require(value.get("schemaVersion") == 1 and value.get("runnerId") == "teamaibox.current-translation-composition-closure.v1"
            and RUN_ID.fullmatch(str(value.get("runId", ""))) is not None and resolved.name == value["runId"] + ".json"
            and value.get("status") == "passed" and value.get("failure") is None
            and value.get("featureKey") == "official.translation" and value.get("task") == "18.8",
            "Translation composition closure identity drifted")
    payload = dict(value); claimed = payload.pop("evidenceDigest", None)
    require(SHA256.fullmatch(str(claimed or "")) is not None and claimed == canonical_digest(payload), "Translation composition closure digest drifted")
    require(value.get("parents") == {key: parent(path) for key, path in PARENTS.items()}, "Translation composition closure parents drifted")
    for key, validator in VALIDATIONS:
        completed = subprocess.run(["python3", validator, "--evidence", str(PARENTS[key])], cwd=ROOT,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=2400, check=False)
        require(completed.returncode == 0, "Translation composition closure parent no longer passes: " + key)
    require(value.get("sources") == [source(RUNNER), source(VALIDATOR), source(TEST)], "Translation composition closure sources drifted")
    focused = subprocess.run(["python3", "-m", "unittest", "tests/test_current_translation_composition_closure.py"],
                             cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False)
    require(focused.returncode == 0 and value.get("sourceTests") == {"passed": True, "focusedPythonTests": 3,
            "outputRetained": False}, "Translation composition closure tests drifted")
    require(value.get("coverage") == coverage() and len(value["coverage"]) == 14 and all(value["coverage"].values()), "Translation composition closure coverage drifted")
    require(value.get("claimBoundary") == {"task18_8Complete": True, "componentReady": True,
                "translationProfileCertification": "experimental", "releaseSoakComplete": False,
                "independentHumanAcceptance": False, "productAccepted": False}
            and value.get("remainingReleaseGates") == ["selected Certified Translation profile qualification/soak",
                "formal-release administrator/member acceptance"]
            and value.get("privacy") == {"credentialsRetained": False, "userContentRetained": False,
                "commandOutputRetained": False, "syntheticScreenshotsRetained": True}
            and not SENSITIVE.search(raw), "Translation composition closure claim/privacy boundary drifted")
    return {"valid": True, "runId": value["runId"], "task18_8Complete": True,
            "componentReady": True, "productAccepted": False, "evidenceDigest": claimed}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--evidence", type=Path, required=True)
    print(json.dumps(validate(parser.parse_args(argv).evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationError, OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
        raise SystemExit("current Translation composition closure validation failed: " + str(error))
