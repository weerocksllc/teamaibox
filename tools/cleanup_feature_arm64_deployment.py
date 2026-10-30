#!/usr/bin/env python3
"""Remove only resources owned by one retained feature deployment."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "architecture" / "validation" / "feature-deployment-runner.v1.json"
EVIDENCE_ROOT = ROOT / "evidence" / "validation" / "feature-deployments"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{7,95}$")

if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))

from tools.spark_validation import RemoteSpark


class FeatureCleanupError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise FeatureCleanupError(message)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _lines(value: str) -> list[str]:
    return sorted(item.strip() for item in value.splitlines() if item.strip())


def _required(result: Any, label: str) -> Any:
    require(result.returncode == 0, f"{label} failed")
    return result


def _remove_staging(remote: Any, staging: str) -> None:
    """Remove one exact runner-owned temporary or durable deployment path."""
    temporary = staging.startswith("/tmp/teamaibox-feature-") and staging.count("/") == 2
    durable = staging.startswith("/var/lib/teamaibox-feature-deployments/") and staging.count("/") == 4
    require(temporary or durable, "deployment-path cleanup target is unsafe")
    removal = remote.run(("rm", "-r", "--", staging), 60) if temporary \
        else remote.run(("sudo", "--non-interactive", "rm", "-r", "--", staging), 60)
    if removal.returncode != 0 and temporary:
        removal = remote.run(("sudo", "--non-interactive", "rm", "-r", "--", staging), 60)
    require(removal.returncode in {0, 1}, "deployment-path cleanup failed")


def _deployment(path: Path) -> dict[str, Any]:
    require(path.is_absolute() and path.is_file() and ROOT in path.parents,
            "parent evidence must be an existing repository file")
    value = json.loads(path.read_text(encoding="utf-8"))
    require(value.get("schemaVersion") in {1, 2} and value.get("runnerId") == "teamaibox.feature-deploy.v1",
            "parent evidence identity drifted")
    if value.get("schemaVersion") == 2:
        expected_root = "/var/lib/teamaibox-feature-deployments/" + str(value.get("runId", ""))
        require(value.get("deploymentRoot") == expected_root
                and value.get("deploymentRootRetained") is True
                and value.get("deploymentMaterialCheckPassed") is True,
                "durable deployment material evidence is incomplete")
    require(value.get("status") == "passed" and value.get("rollbackAttempted") is False,
            "only a successful retained deployment can be cleaned")
    require(value.get("credentialsRetained") is False and value.get("commandOutputRetained") is False,
            "parent evidence retained sensitive material")
    require(isinstance(value.get("runId"), str) and SAFE_ID.fullmatch(value["runId"]) is not None,
            "parent run ID is unsafe")
    project = value.get("composeProject")
    require(isinstance(project, str) and project == "teamaibox_feature_" + re.sub(r"[^a-z0-9]", "_", value["runId"]),
            "parent Compose project identity drifted")
    bindings = value.get("imageBindings")
    require(isinstance(bindings, list) and bindings, "parent image bindings are missing")
    for binding in bindings:
        require(isinstance(binding, Mapping)
                and set(binding) == {"component", "buildTag", "imageId", "platform"}
                and isinstance(binding["buildTag"], str)
                and SHA256.fullmatch(binding.get("imageId", "")) is not None
                and binding.get("platform") == "linux/arm64/v8",
                "parent image binding is invalid")
    return value


def execute_cleanup(
    deployment_path: Path,
    cleanup_id: str,
    output: Path,
    *,
    remote: Any | None = None,
) -> dict[str, Any]:
    require(SAFE_ID.fullmatch(cleanup_id) is not None, "cleanup ID is unsafe")
    require(output.is_absolute() and ROOT in output.parents and not output.exists(),
            "cleanup evidence must be a new repository file")
    deployment = _deployment(deployment_path)
    policy = json.loads(POLICY.read_text(encoding="utf-8"))
    target = policy.get("allowedTargets", {}).get(deployment.get("target"))
    require(isinstance(target, Mapping) and isinstance(target.get("ssh"), str),
            "parent target is not allowlisted")
    remote = remote or RemoteSpark(target["ssh"])
    project = deployment["composeProject"]
    run_id = deployment["runId"]
    staging = "/tmp/teamaibox-feature-" + run_id
    deployment_root = "/var/lib/teamaibox-feature-deployments/" + run_id
    owned_paths = [staging] + ([deployment_root] if deployment["schemaVersion"] == 2 else [])

    containers = _lines(_required(remote.run((
        "docker", "ps", "--all", "--filter", f"label=com.docker.compose.project={project}",
        "--format", "{{.Names}}",
    ), 30), "container inventory").stdout)
    require(containers and all(item.startswith(project + "-") for item in containers),
            "container inventory contains unowned resources")

    volumes = _lines(_required(remote.run((
        "docker", "volume", "ls", "--filter", f"label=com.docker.compose.project={project}",
        "--format", "{{.Name}}",
    ), 30), "volume inventory").stdout)
    require(volumes and all(item.startswith(project + "_") for item in volumes),
            "volume inventory contains unowned resources")

    networks = _lines(_required(remote.run((
        "docker", "network", "ls", "--filter", f"label=com.docker.compose.project={project}",
        "--format", "{{.Name}}",
    ), 30), "network inventory").stdout)
    require(all(item.startswith(project + "_") for item in networks),
            "network inventory contains unowned resources")

    images: list[dict[str, str]] = []
    for binding in deployment["imageBindings"]:
        inspected = _required(remote.run((
            "docker", "image", "inspect", "--format", "{{.Id}}", binding["buildTag"],
        ), 30), f"image inventory {binding['component']}").stdout.strip()
        require(inspected == binding["imageId"], f"image identity changed: {binding['component']}")
        images.append({"tag": binding["buildTag"], "imageId": binding["imageId"]})

    _required(remote.run(("docker", "rm", "--force", *containers), 180), "container cleanup")
    _required(remote.run(("docker", "volume", "rm", *volumes), 180), "volume cleanup")
    if networks:
        _required(remote.run(("docker", "network", "rm", *networks), 180), "network cleanup")
    for item in images:
        _required(remote.run(("docker", "image", "rm", item["tag"]), 180), f"image cleanup {item['tag']}")
    for owned_path in owned_paths:
        _remove_staging(remote, owned_path)

    residual_containers = _lines(_required(remote.run((
        "docker", "ps", "--all", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Names}}",
    ), 30), "residual container check").stdout)
    residual_volumes = _lines(_required(remote.run((
        "docker", "volume", "ls", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Name}}",
    ), 30), "residual volume check").stdout)
    residual_networks = _lines(_required(remote.run((
        "docker", "network", "ls", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Name}}",
    ), 30), "residual network check").stdout)
    stage_check = remote.run(("test", "!", "-e", staging), 10)
    deployment_check = remote.run(("test", "!", "-e", deployment_root), 10) if deployment["schemaVersion"] == 2 else None
    require(not residual_containers and not residual_volumes and not residual_networks and stage_check.returncode == 0
            and (deployment_check is None or deployment_check.returncode == 0),
            "cleanup left run-owned resources")
    for item in images:
        require(remote.run(("docker", "image", "inspect", item["tag"]), 30).returncode != 0,
                f"cleanup left image tag: {item['tag']}")

    parent_reference = deployment_path.relative_to(ROOT).as_posix()
    evidence = {
        "schemaVersion": deployment["schemaVersion"],
        "cleanupId": cleanup_id,
        "target": deployment["target"],
        "parentEvidence": [{"path": parent_reference, "digest": digest_bytes(deployment_path.read_bytes())}],
        "ownedRunIds": [run_id],
        "composeProject": project,
        "containersRemoved": containers,
        "volumesRemoved": volumes,
        "imagesRemoved": images,
        "stagingPathsRemoved": [staging],
        "residualContainerCount": 0,
        "residualVolumeCount": 0,
        "residualStagingPathCount": 0,
        "status": "passed",
        "completedAt": iso_now(),
        "credentialsRetained": False,
        "commandOutputRetained": False,
    }
    if deployment["schemaVersion"] == 2:
        evidence["deploymentPathsRemoved"] = [deployment_root]
        evidence["residualDeploymentPathCount"] = 0
    evidence["evidenceDigest"] = digest_bytes(canonical_bytes(evidence))
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_bytes(json.dumps(evidence, indent=2, ensure_ascii=False).encode("utf-8") + b"\n")
    os.replace(temporary, output)
    return evidence


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--cleanup-id", required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    deployment_path = args.evidence.resolve()
    output = (args.output or EVIDENCE_ROOT / f"{args.cleanup_id}.json").resolve()
    result = execute_cleanup(deployment_path, args.cleanup_id, output)
    print(json.dumps({
        "cleanupId": result["cleanupId"], "parentRunId": result["ownedRunIds"][0],
        "status": result["status"], "evidence": output.relative_to(ROOT).as_posix(),
    }, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FeatureCleanupError, json.JSONDecodeError, OSError) as error:
        print(f"feature ARM64 cleanup failed: {error}")
        raise SystemExit(1)
