#!/usr/bin/env python3
"""Remove exact Docker resources retained by one failed ARM64 feature deployment."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "architecture/validation/feature-deployment-runner.v1.json"
OUTPUT_ROOT = ROOT / "evidence/validation/feature-deployments"
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{7,95}$")
SHA = re.compile(r"^sha256:[0-9a-f]{64}$")

if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))

from tools.spark_validation import RemoteSpark


class CleanupFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CleanupFailure(message)


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def lines(value: str) -> list[str]:
    return sorted(item for item in value.splitlines() if item)


def checked(result, label: str):
    require(result.returncode == 0, f"{label} failed")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--cleanup-id", required=True)
    args = parser.parse_args()
    require(SAFE_ID.fullmatch(args.cleanup_id) is not None, "cleanup ID is unsafe")
    parent_path = args.evidence.resolve()
    require(parent_path.is_file() and ROOT in parent_path.parents, "failed parent evidence is invalid")
    parent_bytes = parent_path.read_bytes()
    parent = json.loads(parent_bytes)
    require(parent.get("runnerId") == "teamaibox.feature-deploy.v1" and parent.get("status") == "failed"
            and parent.get("rollbackAttempted") is True and isinstance(parent.get("rollbackPassed"), bool),
            "parent is not a failed feature deployment with a completed rollback decision")
    run_id = parent.get("runId")
    project = parent.get("composeProject")
    require(isinstance(run_id, str) and SAFE_ID.fullmatch(run_id) is not None
            and project == "teamaibox_feature_" + run_id.replace("-", "_"), "failed run identity is unsafe")
    output = OUTPUT_ROOT / f"{args.cleanup_id}.json"
    require(not output.exists(), "cleanup evidence exists; use a new immutable cleanup ID")
    policy = json.loads(POLICY.read_text())
    target = policy["allowedTargets"].get(parent.get("target"))
    require(isinstance(target, dict) and isinstance(target.get("ssh"), str), "failed target is not allowlisted")
    remote = RemoteSpark(target["ssh"])
    inventories = {}
    for kind, command, prefix in (
        ("containers", ("docker", "ps", "--all", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Names}}"), project + "-"),
        ("volumes", ("docker", "volume", "ls", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Name}}"), project + "_"),
        ("networks", ("docker", "network", "ls", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Name}}"), project + "_"),
    ):
        values = lines(checked(remote.run(command, 60), f"{kind} inventory").stdout)
        require(all(item.startswith(prefix) for item in values), f"{kind} inventory contains unowned resources")
        inventories[kind] = values
    images = []
    for binding in parent.get("imageBindings", []):
        require(isinstance(binding, dict) and SHA.fullmatch(binding.get("imageId", "")) is not None,
                "failed image binding is invalid")
        actual = checked(remote.run(("docker", "image", "inspect", "--format", "{{.Id}}", binding["buildTag"]), 30),
                         "failed image inventory").stdout.strip()
        require(actual == binding["imageId"], "failed image tag identity changed")
        images.append({"tag": binding["buildTag"], "imageId": actual})
    if inventories["containers"]:
        checked(remote.run(("docker", "rm", "--force", *inventories["containers"]), 300), "failed container cleanup")
    if inventories["volumes"]:
        checked(remote.run(("docker", "volume", "rm", *inventories["volumes"]), 300), "failed volume cleanup")
    if inventories["networks"]:
        checked(remote.run(("docker", "network", "rm", *inventories["networks"]), 300), "failed network cleanup")
    for image in images:
        checked(remote.run(("docker", "image", "rm", image["tag"]), 120), "failed image cleanup")
    staging = "/tmp/teamaibox-feature-" + run_id
    deployment_root = "/var/lib/teamaibox-feature-deployments/" + run_id
    removal = remote.run(("rm", "-r", "--", staging), 60)
    require(removal.returncode in {0, 1}, "failed staging cleanup failed")
    if parent.get("schemaVersion") == 2:
        removal = remote.run(("sudo", "--non-interactive", "rm", "-r", "--", deployment_root), 60)
        require(removal.returncode in {0, 1}, "failed durable deployment cleanup failed")
    residuals = {
        "containers": lines(checked(remote.run(("docker", "ps", "--all", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Names}}"), 60), "container residual check").stdout),
        "volumes": lines(checked(remote.run(("docker", "volume", "ls", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Name}}"), 60), "volume residual check").stdout),
        "networks": lines(checked(remote.run(("docker", "network", "ls", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Name}}"), 60), "network residual check").stdout),
    }
    require(not any(residuals.values()) and remote.run(("test", "!", "-e", staging), 10).returncode == 0
            and (parent.get("schemaVersion") != 2 or remote.run(("test", "!", "-e", deployment_root), 10).returncode == 0),
            "failed deployment cleanup left run-owned resources")
    evidence = {
        "schemaVersion": parent.get("schemaVersion", 1), "runnerId": "teamaibox.failed-feature-cleanup.v1", "cleanupId": args.cleanup_id,
        "status": "passed", "target": parent["target"], "composeProject": project,
        "parentEvidence": {"path": parent_path.relative_to(ROOT).as_posix(), "digest": digest(parent_bytes)},
        "ownedRunId": run_id, "parentRollbackPassed": parent["rollbackPassed"],
        "containersRemoved": inventories["containers"],
        "volumesRemoved": inventories["volumes"], "networksRemoved": inventories["networks"],
        "imagesRemoved": images, "stagingPathRemoved": staging,
        "residualCounts": {key: len(value) for key, value in residuals.items()},
        "completedAt": now(), "credentialsRetained": False, "commandOutputRetained": False,
    }
    if parent.get("schemaVersion") == 2:
        evidence["deploymentPathRemoved"] = deployment_root
    evidence["evidenceDigest"] = digest(json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode())
    output.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"cleanupId": args.cleanup_id, "status": "passed", "evidence": output.relative_to(ROOT).as_posix()}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (CleanupFailure, OSError, json.JSONDecodeError) as error:
        print(f"failed feature cleanup failed: {error}")
        raise SystemExit(1)
