#!/usr/bin/env python3
"""Strictly validate the current realtime browser runtime binding."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
from typing import Any, Sequence

from run_current_realtime_browser_binding import (
    ASR, PLATFORM, REMOTE, ROOT, RUN_ID, SOURCES, WEB, WORKER, digest, inspect,
)
from run_spark_model_baseline import canonical_digest


class ValidationFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationFailure(message)


def validate(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(value.get("schemaVersion") == 1
            and value.get("runnerId") == "teamaibox.current-realtime-browser-binding.v1"
            and RUN_ID.fullmatch(str(value.get("runId", ""))) is not None
            and value.get("status") == "passed" and path.name == value["runId"] + ".json",
            "current realtime browser binding identity drifted")
    recorded = value.pop("evidenceDigest", None)
    require(recorded == canonical_digest(value), "current realtime browser binding digest drifted")
    value["evidenceDigest"] = recorded
    parent = value.get("webParent", {})
    parent_path = (ROOT / str(parent.get("path", ""))).resolve()
    require(parent_path.is_relative_to(ROOT / "evidence/validation/feature-deployments") and parent_path.is_file(),
            "current realtime browser Web parent is unsafe")
    parent_value = json.loads(parent_path.read_text(encoding="utf-8"))
    parent_digest = parent_value.pop("evidenceDigest", None)
    require(parent_digest == canonical_digest(parent_value)
            and parent_value.get("runnerId") == "teamaibox.current-browser-runtime-qualification.v1"
            and parent_value.get("status") == "passed"
            and parent == {"path": parent_path.relative_to(ROOT).as_posix(), "runId": parent_value["runId"],
                           "evidenceDigest": parent_digest, "fileSha256": digest(parent_path.read_bytes())},
            "current realtime browser Web parent binding drifted")
    require([item.get("path") for item in value.get("sources", [])] == list(SOURCES),
            "current realtime browser source inventory drifted")
    for item in value["sources"]:
        selected = ROOT / item["path"]
        require(selected.is_file() and item.get("sha256") == digest(selected.read_bytes()),
                f"current realtime browser source drifted: {item['path']}")
    tests = subprocess.run(["python3", "-m", "unittest", "tests/test_current_realtime_browser_binding_sources.py"],
                           cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120, check=False)
    require(tests.returncode == 0, "current realtime browser binding source tests failed")
    expected_names = {"platform": PLATFORM, "web": WEB, "asrPlugin": ASR, "realtimeWorker": WORKER}
    runtime = value.get("runtime", {})
    require(set(runtime) == set(expected_names), "current realtime browser runtime inventory drifted")
    for key, name in expected_names.items():
        current = inspect(name)
        fact = runtime[key]
        require(fact == {"name": name, "containerId": current["Id"], "imageId": current["Image"],
                         "healthy": True, "startedAt": current["State"]["StartedAt"]},
                f"current realtime browser runtime drifted: {key}")
    require(runtime["platform"]["containerId"] == parent_value["components"]["platform"]["containerId"]
            and runtime["web"]["containerId"] == parent_value["components"]["canonicalWeb"]["containerId"]
            and runtime["web"]["imageId"] == parent_value["images"]["web"]["imageId"],
            "current realtime browser runtime is bound to another Web successor")
    require(value.get("releaseEvidenceEligible") is False and value.get("productAccepted") is False
            and value.get("claimBoundary") == {"browserTrustedHttps": True,
                                                "independentHumanAcceptance": False,
                                                "runtimeBindingOnly": True},
            "current realtime browser binding overclaims acceptance")
    return {"valid": True, "live": True, "runId": value["runId"],
            "webImageId": runtime["web"]["imageId"], "asrImageId": runtime["asrPlugin"]["imageId"],
            "workerImageId": runtime["realtimeWorker"]["imageId"], "releaseEvidenceEligible": False}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    selected = args.evidence.resolve()
    require(selected.is_relative_to(ROOT / "evidence/validation/browser") and selected.is_file(),
            "current realtime browser binding path is unsafe")
    print(json.dumps(validate(selected), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationFailure, OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"current realtime browser binding validation failed: {error}")
