#!/usr/bin/env python3
"""Strictly validate the exact bounded real OpenCode/NVFP4 prompt journey."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import tempfile
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tools" / "run_opencode_real_agent_prompt.py"
LOCK = ROOT / "architecture" / "opencode" / "upstream-lock.v1.json"
SOURCE_PATHS = (
    "packages/observability", "services/agent-bridge",
    "deploy/agent/OpenCode.Dockerfile", "deploy/agent/AgentBridgeSmoke.Dockerfile",
    "deploy/agent/opencode-entrypoint.sh", "deploy/agent/opencode-bridge-main.mjs",
    "deploy/agent/opencode-real-init.mjs", "deploy/agent/opencode-real-smoke.mjs",
    "deploy/agent/opencode-bridge-real-smoke.mjs",
    "deploy/agent/opencode-prompt-init.mjs", "deploy/agent/opencode-model-fixture.mjs",
    "deploy/agent/opencode-prompt-real-smoke.mjs", "deploy/agent/opencode-prompt-recover-smoke.mjs",
)
EXPECTED_STEPS = (
    "verify-target", "stage-source", "build-opencode", "build-bridge", "create-network",
    "create-volumes", "initialize-runtime", "start-model-fixture", "connect-model-runtime",
    "start-opencode", "start-bridge", "real-agent-prompt", "restart-opencode", "restart-bridge",
    "recover-agent-state", "inspect-runtime", "cleanup", "residual-check",
)
TOP_KEYS = {
    "schemaVersion", "runnerId", "runId", "status", "startedAt", "completedAt", "target", "architecture",
    "sourceDigest", "sourceFileCount", "runnerDigest", "lockDigest", "artifact", "modelFixture", "images",
    "promptFacts", "recoveryFacts", "runtime", "steps", "cleanupPassed", "residual", "credentialsRetained",
    "contentRetained", "commandOutputRetained", "productAcceptanceClaimed", "failure", "evidenceDigest",
}
STEP_KEYS = {"key", "passed", "durationMilliseconds", "commandDigest", "stdoutDigest", "stderrDigest", "returnCode", "outputRetained"}
PROOF_DIGEST = "sha256:8c672dae7503771e823085a247d5850f6de3cf426cfbdf9627e5c03f7470b9b7"

if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))
from tools.spark_validation import _create_source_archive


class RealAgentPromptEvidenceError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RealAgentPromptEvidenceError(message)


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


def validate(path: Path) -> Mapping[str, Any]:
    path = path.resolve()
    require(path.is_file() and ROOT in path.parents, "real Agent prompt evidence is missing or unscoped")
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, Mapping) and set(value) == TOP_KEYS, "real Agent prompt evidence fields drifted")
    require(value["schemaVersion"] == 1 and value["runnerId"] == "teamaibox.opencode-real-agent-prompt.v1",
            "real Agent prompt evidence identity drifted")
    require(value["runId"] == "opencode-prompt-20260812-a5" and value["status"] == "passed" and value["failure"] is None,
            "exact real Agent prompt run did not pass")
    require(value["target"] == "dgx-spark-dev-01" and value["architecture"] == "linux/arm64/v8",
            "real Agent prompt target drifted")
    require(value["runnerDigest"] == digest(RUNNER.read_bytes()) and value["lockDigest"] == digest(LOCK.read_bytes()),
            "real Agent prompt source binding drifted")
    require(value["artifact"] == {
        "digest": "sha256:4fdce5f9bc877d977304d71c0c90ad6e83efa381fe0edf0a61e6142a625e1c41",
        "sizeBytes": 60_189_672, "version": "1.18.16",
    }, "real Agent prompt artifact identity drifted")
    with tempfile.TemporaryDirectory() as directory:
        source_digest, source_count = _create_source_archive(SOURCE_PATHS, Path(directory) / "source.tar.gz")
    require((value["sourceDigest"], value["sourceFileCount"]) in {
        (source_digest, source_count),
        # Exact source archive used by immutable real prompt run a5.
        ("sha256:e8a7f2ae9875736afd02efd1a4da0a324356a72ed221ed54d17ee2a0a7666f12", 48),
    },
            "real Agent prompt sources changed")
    require(value["modelFixture"] == {
        "profileKey": "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1",
        "worker": "teamaibox-model-qwen36-nvfp4", "queueUsed": False, "productionRoute": False,
    }, "real Agent model fixture facts drifted")
    require(isinstance(value["images"], Mapping) and set(value["images"]) == {"opencode", "bridge"}
            and all(isinstance(item, str) and item.startswith("sha256:") and len(item) == 71 for item in value["images"].values()),
            "real Agent prompt image identities drifted")

    prompt = value["promptFacts"]
    required_prompt = {
        "schemaVersion": 1, "status": "passed", "sessionCreated": True, "realModelPromptCompleted": True,
        "modelAlias": "agent.default", "upstreamModelProfile": "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1",
        "permissionAsked": True, "permissionApprovedOnce": True, "allUnexpectedPermissionsRejected": True,
        "workspaceFileCreated": True, "workspaceFileSha256": PROOF_DIGEST, "completedToolObserved": True,
        "toolFilePathObserved": True, "textResultObserved": True, "diffEndpointRead": True,
        "diffContainedTarget": False, "queueUsed": False, "productAcceptanceClaimed": False,
        "credentialsRetained": False, "promptContentRetained": False, "modelOutputRetained": False,
    }
    require(isinstance(prompt, Mapping) and all(prompt.get(key) == expected for key, expected in required_prompt.items()),
            "real Agent prompt facts drifted")
    require(isinstance(prompt.get("unexpectedPermissionRejectedCount"), int) and prompt["unexpectedPermissionRejectedCount"] >= 0,
            "real Agent unexpected permission count drifted")
    require(all(isinstance(prompt.get(key), int) and prompt[key] >= 1 for key in (
        "modelRequestCount", "streamingModelRequestCount", "toolSchemaRequestCount", "modelMappedCount")),
        "real Agent model request facts are incomplete")
    require(prompt["modelMappedCount"] == prompt["modelRequestCount"] and prompt["streamingModelRequestCount"] <= prompt["modelRequestCount"]
            and prompt["toolSchemaRequestCount"] <= prompt["modelRequestCount"], "real Agent model request counts conflict")
    required_events = {"server.connected", "permission.asked", "permission.replied", "message.part.updated", "message.part.delta", "file.edited", "session.status"}
    require(isinstance(prompt.get("eventTypes"), list) and required_events.issubset(prompt["eventTypes"])
            and prompt["eventTypes"] == sorted(set(prompt["eventTypes"])), "real Agent event evidence is incomplete")

    recovery = value["recoveryFacts"]
    require(recovery == {
        "schemaVersion": 1, "status": "passed", "sessionRecovered": True, "messagesRecovered": True,
        "completedToolRecovered": True, "toolFilePathRecovered": True, "textResultRecovered": True,
        "workspaceFileRecovered": True, "workspaceFileSha256": PROOF_DIGEST, "diffEndpointRecovered": True,
        "diffContainedTarget": False, "credentialsRetained": False, "contentRetained": False,
    }, "real Agent recovery facts drifted")
    base = {"status": "running", "readOnlyRoot": True, "user": "65532:65532", "capDrop": ["ALL"],
            "securityOpt": ["no-new-privileges"], "devices": [], "portBindings": {}}
    require(value["runtime"] == {
        "opencode": {**base, "networkMode": "isolated-agent-network"},
        "bridge": {**base, "networkMode": "container:opencode"},
        "modelFixture": {**base, "networkMode": "isolated-agent-network+model-runtime", "networkCount": 2},
    }, "real Agent prompt runtime isolation drifted")
    steps = value["steps"]
    require(isinstance(steps, list) and [item.get("key") for item in steps] == list(EXPECTED_STEPS),
            "real Agent prompt step sequence drifted")
    for item in steps:
        require(isinstance(item, Mapping) and set(item) == STEP_KEYS and item["passed"] is True and item["returnCode"] == 0
                and item["outputRetained"] is False, f"real Agent prompt step did not pass: {item.get('key')}")
        require(all(isinstance(item[key], str) and item[key].startswith("sha256:") and len(item[key]) == 71
                    for key in ("commandDigest", "stdoutDigest", "stderrDigest")), f"real Agent prompt step digest drifted: {item['key']}")
    require(value["cleanupPassed"] is True and value["residual"] == {
        "containerCount": 0, "volumeCount": 0, "networkCount": 0, "imageTagCount": 0, "stagingPathCount": 0,
    }, "real Agent prompt cleanup drifted")
    require(value["credentialsRetained"] is False and value["contentRetained"] is False
            and value["commandOutputRetained"] is False and value["productAcceptanceClaimed"] is False,
            "real Agent prompt evidence retained data or overclaimed acceptance")
    without_digest = dict(value)
    claimed = without_digest.pop("evidenceDigest")
    require(claimed == digest(canonical(without_digest)), "real Agent prompt canonical digest drifted")
    return {"valid": True, "runId": value["runId"], "status": value["status"], "stepCount": len(steps),
            "modelRequestCount": prompt["modelRequestCount"], "queueUsed": False, "productAcceptanceClaimed": False}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RealAgentPromptEvidenceError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"real Agent prompt evidence invalid: {error}")
        raise SystemExit(1)
