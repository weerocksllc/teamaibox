#!/usr/bin/env python3
"""Fail closed when the pinned OpenCode adapter, policy, or evidence drifts."""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import subprocess

try:
    from tools import validate_opencode_upstream
    from tools import validate_opencode_real_compatibility
    from tools import validate_opencode_real_agent_prompt
except ModuleNotFoundError:  # Direct execution places tools/, not the repository root, on sys.path.
    import validate_opencode_upstream
    import validate_opencode_real_compatibility
    import validate_opencode_real_agent_prompt

ROOT = pathlib.Path(__file__).resolve().parents[1]
GATE = ROOT / "architecture/opencode/compatibility-gate.v1.json"
EVIDENCE = ROOT / "architecture/opencode/compatibility-evidence.v1.json"
POLICY = ROOT / "deploy/agent/sandbox-policy.v1.json"

CAPABILITIES = {
    "health", "session-creation", "prompt", "ordered-sse-events", "questions",
    "tool-confirmations", "interrupt", "diff", "artifacts", "bounded-errors",
}


def require(value: bool, message: str) -> None:
    if not value:
        raise ValueError(message)


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def repository_path(value: object, label: str) -> pathlib.Path:
    require(isinstance(value, str) and value and not value.startswith("/"), f"{label} path is invalid")
    path = (ROOT / value).resolve()
    require(path.is_relative_to(ROOT) and path.is_file(), f"{label} path is unavailable")
    return path


def load_and_validate() -> tuple[dict, dict]:
    lock = validate_opencode_upstream.load_and_validate()
    gate = json.loads(GATE.read_text())
    evidence = json.loads(EVIDENCE.read_text())
    policy = json.loads(POLICY.read_text())
    require(gate.get("schemaVersion") == 1, "OpenCode compatibility gate schema is invalid")
    require(evidence.get("schemaVersion") == 1 and evidence.get("result") == "passed", "OpenCode compatibility evidence is not passed")
    release = lock["upstream"]["release"]
    source = lock["upstream"]["providedSource"]
    artifact = lock["runtimeArtifact"]
    expected_gate_id = f"opencode.compatibility.v{source['packageVersion']}.arm64"
    require(gate.get("gateId") == expected_gate_id and evidence.get("gateId") == expected_gate_id,
            "OpenCode compatibility evidence does not bind the pinned version")
    require(gate.get("adapterKey") == lock["adapterKey"], "OpenCode adapter key drifted")
    require(gate.get("upstreamVersion") == source["packageVersion"] and gate.get("releaseTag") == release["tag"],
            "OpenCode compatibility version drifted")
    require(gate.get("releaseTree") == source["tree"] == release["tree"], "OpenCode compatibility source tree drifted")
    require(gate.get("artifact") == {"platform": artifact["platform"], "digest": artifact["digest"]},
            "OpenCode compatibility artifact drifted")

    implementation = gate.get("implementation", {})
    adapter = repository_path(implementation.get("adapterPath"), "adapter")
    registry = repository_path(implementation.get("registryPath"), "registry")
    require(implementation.get("adapterSha256") == sha256(adapter), "OpenCode adapter changed without compatibility evidence")
    require(implementation.get("registrySha256") == sha256(registry), "OpenCode adapter registry changed without compatibility evidence")
    adapter_text = adapter.read_text()
    require(source["packageVersion"] in adapter_text and artifact["digest"] in adapter_text,
            "OpenCode adapter does not enforce the pinned version and artifact")

    runtime = gate.get("runtimePolicy", {})
    policy_path = repository_path(runtime.get("policyPath"), "runtime policy")
    require(policy_path == POLICY and runtime.get("policySha256") == sha256(POLICY),
            "OpenCode runtime policy changed without compatibility evidence")
    opencode = policy.get("opencode", {})
    lock_runtime = lock.get("runtimePolicy", {})
    require(runtime.get("requiredEnvironment") == opencode.get("environment") == lock_runtime.get("requiredEnvironment"),
            "OpenCode hardening environment differs across policy, lock, and gate")
    require(runtime.get("configurationTarget") == opencode.get("configTarget") == lock_runtime.get("configurationTarget"),
            "OpenCode immutable configuration target drifted")
    require(runtime.get("configurationOwner") == lock_runtime.get("configurationOwner") == "root:root" and
            runtime.get("configurationMode") == lock_runtime.get("configurationMode") == "0444",
            "OpenCode immutable configuration ownership drifted")
    require(runtime.get("approvedProviders") == lock_runtime.get("approvedProviders") == ["teamaibox"] and
            runtime.get("approvedPlugins") == opencode.get("approvedPlugins") == lock_runtime.get("approvedPlugins") == [],
            "OpenCode providers or plugins are not restricted")

    declarations = gate.get("requiredCapabilities", [])
    keys = [item.get("key") for item in declarations if isinstance(item, dict)]
    require(set(keys) == CAPABILITIES and len(keys) == len(CAPABILITIES), "OpenCode capability gate is incomplete or duplicated")
    for item in declarations:
        repository_path(item.get("evidence"), f"{item.get('key')} evidence")
    require(gate.get("upgradeRule") == "all-lock-policy-source-and-contract-checks-must-pass-before-registry-version-change",
            "OpenCode upgrade rule drifted")

    facts = evidence.get("facts", {})
    require(facts.get("providedSourceCommit") == source["commit"] and facts.get("providedSourceTree") == source["tree"] and
            facts.get("releaseTag") == release["tag"] and facts.get("releaseTree") == release["tree"] and
            facts.get("artifactDigest") == artifact["digest"] and facts.get("runtimePolicySha256") == sha256(POLICY) and
            facts.get("sourceTreeMatchesRelease") is True and
            facts.get("upstreamModifiedByPlatform") is False,
            "OpenCode recorded compatibility facts drifted")
    real_evidence = repository_path(facts.get("realSparkEvidencePath"), "real Spark evidence")
    real_result = validate_opencode_real_compatibility.validate(real_evidence)
    real_value = json.loads(real_evidence.read_text())
    require(real_result.get("valid") is True and real_result.get("runId") == "opencode-compat-20260812-a6" and
            facts.get("realSparkEvidenceDigest") == real_value.get("evidenceDigest"),
            "OpenCode real Spark compatibility evidence drifted")
    prompt_evidence = repository_path(facts.get("realModelPromptEvidencePath"), "real model prompt evidence")
    prompt_result = validate_opencode_real_agent_prompt.validate(prompt_evidence)
    prompt_value = json.loads(prompt_evidence.read_text())
    require(prompt_result.get("valid") is True and prompt_result.get("runId") == "opencode-prompt-20260812-a5"
            and prompt_result.get("queueUsed") is False and prompt_result.get("productAcceptanceClaimed") is False
            and facts.get("realModelPromptEvidenceDigest") == prompt_value.get("evidenceDigest"),
            "OpenCode real model prompt evidence drifted or overclaimed acceptance")
    checks = evidence.get("checks", [])
    check_keys = {item.get("key") for item in checks if isinstance(item, dict) and item.get("result") == "passed" and item.get("command")}
    require(check_keys == {"upstream-lock", "adapter-contract", "restricted-model-config", "node-agent-runtime-boundary", "real-arm64-sidecar", "real-nvfp4-prompt"},
            "OpenCode compatibility checks are incomplete")
    return gate, evidence


def run_checks() -> None:
    commands = [
        ["python3", "tools/validate_opencode_upstream.py", "--verify-provided-source"],
        ["node", "--test", "services/agent-bridge/test/opencode-adapter-v1-18.test.mjs"],
        ["node", "--test", "services/agent-bridge/test/agent-model-access-service.test.mjs",
         "services/agent-bridge/test/agent-sandbox.test.mjs", "services/agent-bridge/test/node-agent-sandbox-projector.test.mjs"],
        ["go", "-C", "services/node-agent", "test", "./..."],
        ["python3", "tools/validate_opencode_real_compatibility.py", "--evidence",
         "evidence/validation/opencode/opencode-compat-20260812-a6.json"],
        ["python3", "tools/validate_opencode_real_agent_prompt.py", "--evidence",
         "evidence/validation/opencode/opencode-prompt-20260812-a5.json"],
    ]
    for command in commands:
        subprocess.run(command, cwd=ROOT, check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-tests", action="store_true")
    args = parser.parse_args()
    gate, _ = load_and_validate()
    if args.run_tests:
        run_checks()
    print(f"OpenCode compatibility gate passed: {gate['gateId']}")


if __name__ == "__main__":
    main()
