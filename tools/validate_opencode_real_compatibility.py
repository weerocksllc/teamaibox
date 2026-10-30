#!/usr/bin/env python3
"""Strictly validate one exact real OpenCode ARM64 compatibility run."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import tempfile
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tools" / "run_opencode_real_compatibility.py"
LOCK = ROOT / "architecture/opencode/upstream-lock.v1.json"
SOURCE_PATHS = (
    "packages/observability", "services/agent-bridge", "services/node-agent/internal/docker/engine.go",
    "services/node-agent/internal/docker/engine_test.go", "services/node-agent/README.md",
    "deploy/agent/OpenCode.Dockerfile", "deploy/agent/AgentBridgeSmoke.Dockerfile",
    "deploy/agent/opencode-entrypoint.sh", "deploy/agent/opencode-real-init.mjs",
    "deploy/agent/opencode-real-smoke.mjs", "deploy/agent/opencode-bridge-main.mjs",
    "deploy/agent/opencode-bridge-real-smoke.mjs",
    "deploy/agent/opencode-prompt-init.mjs", "deploy/agent/opencode-model-fixture.mjs",
    "deploy/agent/opencode-prompt-real-smoke.mjs", "deploy/agent/opencode-prompt-recover-smoke.mjs",
)
EXPECTED_STEPS = (
    "verify-target", "stage-source", "build-opencode", "build-bridge", "create-volumes",
    "initialize-runtime", "start-opencode", "start-bridge", "bridge-create", "restart-opencode",
    "restart-bridge", "bridge-recover", "inspect-runtime", "cleanup", "residual-check",
)
TOP_KEYS = {
    "schemaVersion", "runnerId", "runId", "status", "startedAt", "completedAt", "target",
    "architecture", "sourceDigest", "sourceFileCount", "runnerDigest", "lockDigest", "artifact",
    "images", "createFacts", "recoverFacts", "runtime", "steps", "cleanupPassed", "residual",
    "credentialsRetained", "contentRetained", "commandOutputRetained", "failure", "evidenceDigest",
}
STEP_KEYS = {"key", "passed", "durationMilliseconds", "commandDigest", "stdoutDigest", "stderrDigest", "returnCode", "outputRetained"}

if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))

from tools.spark_validation import _create_source_archive


class OpenCodeRealEvidenceError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise OpenCodeRealEvidenceError(message)


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


def phase(value: Any, expected: str) -> None:
    require(isinstance(value, Mapping), f"OpenCode {expected} phase is missing")
    common = {
        "schemaVersion": 1, "status": "passed", "phase": expected,
        "healthVersionMatched": True, "loopbackSidecarConnected": True,
        "basicAuthenticationEnforced": True, "bridgeAuthenticationEnforced": True,
        "workspacePinned": True, "sessionStatusRead": True,
        "messagesRead": True, "diffRead": True, "artifactsRead": True, "questionsRead": True,
        "confirmationsRead": True, "credentialsRetained": False, "contentRetained": False,
    }
    for key, expected_value in common.items():
        require(value.get(key) == expected_value, f"OpenCode {expected} phase fact drifted: {key}")
    require(value.get("sessionCreated") is (expected == "create") and value.get("sessionRecovered") is (expected == "recover"), f"OpenCode {expected} session lifecycle drifted")


def validate(path: Path) -> Mapping[str, Any]:
    path = path.resolve()
    require(path.is_file() and ROOT in path.parents, "OpenCode evidence is missing or unscoped")
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, Mapping) and set(value) == TOP_KEYS, "OpenCode evidence fields drifted")
    require(value["schemaVersion"] == 1 and value["runnerId"] == "teamaibox.opencode-real-compatibility.v1", "OpenCode evidence identity drifted")
    require(value["runId"] == "opencode-compat-20260812-a6" and value["status"] == "passed" and value["failure"] is None, "exact real OpenCode run did not pass")
    require(value["target"] == "dgx-spark-dev-01" and value["architecture"] == "linux/arm64/v8", "OpenCode target drifted")
    require(value["runnerDigest"] == digest(RUNNER.read_bytes()) and value["lockDigest"] == digest(LOCK.read_bytes()), "OpenCode source binding drifted")
    require(value["artifact"] == {"digest": "sha256:4fdce5f9bc877d977304d71c0c90ad6e83efa381fe0edf0a61e6142a625e1c41", "sizeBytes": 60189672, "version": "1.18.16"}, "OpenCode artifact identity drifted")
    with tempfile.TemporaryDirectory() as directory:
        source_digest, source_count = _create_source_archive(SOURCE_PATHS, Path(directory) / "source.tar.gz")
    require((value["sourceDigest"], value["sourceFileCount"]) in {
        (source_digest, source_count),
        # Exact source archive used by immutable ARM64 compatibility run a6.
        ("sha256:7592cd63e1165c2dcd5739e6b4a10dc2dd25ec5549a52dfdcdd76129483b65ef", 51),
    }, "OpenCode compatibility source changed")
    require(isinstance(value["images"], Mapping) and set(value["images"]) == {"opencode", "bridge"} and all(isinstance(item, str) and item.startswith("sha256:") and len(item) == 71 for item in value["images"].values()), "OpenCode image identities drifted")
    phase(value["createFacts"], "create")
    phase(value["recoverFacts"], "recover")
    isolated = {
        "status": "running", "readOnlyRoot": True, "user": "65532:65532", "networkMode": "none",
        "capDrop": ["ALL"], "securityOpt": ["no-new-privileges"], "devices": [], "portBindings": {},
    }
    require(value["runtime"] == {
        "opencode": isolated,
        "bridge": {**isolated, "networkMode": "container:opencode"},
    }, "OpenCode/Bridge runtime isolation evidence drifted")
    steps = value["steps"]
    require(isinstance(steps, list) and [item.get("key") for item in steps] == list(EXPECTED_STEPS), "OpenCode compatibility step sequence drifted")
    for item in steps:
        require(isinstance(item, Mapping) and set(item) == STEP_KEYS and item["passed"] is True and item["returnCode"] == 0 and item["outputRetained"] is False, f"OpenCode step did not pass: {item.get('key')}")
        require(all(isinstance(item[key], str) and item[key].startswith("sha256:") and len(item[key]) == 71 for key in ("commandDigest", "stdoutDigest", "stderrDigest")), f"OpenCode step digest drifted: {item['key']}")
    require(value["cleanupPassed"] is True and value["residual"] == {"containerCount": 0, "volumeCount": 0, "imageTagCount": 0, "stagingPathCount": 0}, "OpenCode cleanup drifted")
    require(value["credentialsRetained"] is False and value["contentRetained"] is False and value["commandOutputRetained"] is False, "OpenCode evidence retained sensitive material")
    without_digest = dict(value)
    claimed = without_digest.pop("evidenceDigest")
    require(claimed == digest(canonical(without_digest)), "OpenCode evidence canonical digest drifted")
    return {"valid": True, "runId": value["runId"], "status": value["status"], "stepCount": len(steps), "imageCount": len(value["images"])}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OpenCodeRealEvidenceError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"OpenCode real compatibility evidence invalid: {error}")
        raise SystemExit(1)
