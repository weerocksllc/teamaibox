#!/usr/bin/env python3
"""Clean a superseded feature stack while retaining image tags used by other stacks."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
from typing import Any, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "architecture/validation/feature-deployment-runner.v1.json"
OUTPUT_ROOT = ROOT / "evidence/validation/feature-deployments"
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{7,95}$")

if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))

from tools.cleanup_feature_arm64_deployment import _deployment, _lines, _remove_staging
from tools.run_feature_arm64_deployment import canonical_bytes, digest_bytes
from tools.spark_validation import RemoteSpark


class SupersededCleanupError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SupersededCleanupError(message)


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _checked(result: Any, label: str) -> Any:
    require(result.returncode == 0, f"{label} failed")
    return result


def _consumer_rows(value: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for line in _lines(value):
        name, separator, project = line.partition("|")
        require(separator == "|" and name, "image consumer inventory is malformed")
        rows.append({"container": name, "composeProject": project})
    return rows


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

    inventories: dict[str, list[str]] = {}
    for kind, command, prefix in (
        ("containers", ("docker", "ps", "--all", "--filter", f"label=com.docker.compose.project={project}",
                        "--format", "{{.Names}}"), project + "-"),
        ("volumes", ("docker", "volume", "ls", "--filter", f"label=com.docker.compose.project={project}",
                     "--format", "{{.Name}}"), project + "_"),
        ("networks", ("docker", "network", "ls", "--filter", f"label=com.docker.compose.project={project}",
                      "--format", "{{.Name}}"), project + "_"),
    ):
        values = _lines(_checked(remote.run(command, 60), f"{kind} inventory").stdout)
        require(all(item.startswith(prefix) for item in values), f"{kind} inventory contains unowned resources")
        inventories[kind] = values

    images_removed: list[dict[str, str]] = []
    images_retained: list[dict[str, Any]] = []
    images_already_absent: list[dict[str, str]] = []
    present_without_external_consumers: list[dict[str, str]] = []
    for binding in deployment["imageBindings"]:
        tag = binding["buildTag"]
        expected_id = binding["imageId"]
        inspected = remote.run(("docker", "image", "inspect", "--format", "{{.Id}}", tag), 30)
        consumers = _consumer_rows(_checked(remote.run((
            "docker", "ps", "--all", "--filter", f"ancestor={expected_id}",
            "--format", '{{.Names}}|{{.Label "com.docker.compose.project"}}',
        ), 60), f"image consumer inventory {binding['component']}").stdout)
        external = sorted((row for row in consumers if row["composeProject"] != project),
                          key=lambda row: (row["composeProject"], row["container"]))
        if inspected.returncode != 0:
            images_already_absent.append({"tag": tag, "imageId": expected_id})
            continue
        actual_id = inspected.stdout.strip()
        require(actual_id == expected_id, f"image identity changed: {binding['component']}")
        if external:
            images_retained.append({"tag": tag, "imageId": expected_id, "externalConsumers": external})
        else:
            present_without_external_consumers.append({"tag": tag, "imageId": expected_id})

    if inventories["containers"]:
        _checked(remote.run(("docker", "rm", "--force", *inventories["containers"]), 300), "container cleanup")
    if inventories["volumes"]:
        _checked(remote.run(("docker", "volume", "rm", *inventories["volumes"]), 300), "volume cleanup")
    if inventories["networks"]:
        _checked(remote.run(("docker", "network", "rm", *inventories["networks"]), 300), "network cleanup")
    for item in present_without_external_consumers:
        _checked(remote.run(("docker", "image", "rm", item["tag"]), 180), f"image cleanup {item['tag']}")
        images_removed.append(item)
    _remove_staging(remote, staging)
    if deployment["schemaVersion"] == 2:
        _remove_staging(remote, deployment_root)

    residuals = {
        "containers": _lines(_checked(remote.run(("docker", "ps", "--all", "--filter",
            f"label=com.docker.compose.project={project}", "--format", "{{.Names}}"), 60),
            "container residual check").stdout),
        "volumes": _lines(_checked(remote.run(("docker", "volume", "ls", "--filter",
            f"label=com.docker.compose.project={project}", "--format", "{{.Name}}"), 60),
            "volume residual check").stdout),
        "networks": _lines(_checked(remote.run(("docker", "network", "ls", "--filter",
            f"label=com.docker.compose.project={project}", "--format", "{{.Name}}"), 60),
            "network residual check").stdout),
    }
    require(not any(residuals.values()) and remote.run(("test", "!", "-e", staging), 10).returncode == 0
            and (deployment["schemaVersion"] == 1 or remote.run(("test", "!", "-e", deployment_root), 10).returncode == 0),
            "cleanup left run-owned project resources")
    for item in images_removed + images_already_absent:
        require(remote.run(("docker", "image", "inspect", item["tag"]), 30).returncode != 0,
                f"cleanup left removable image tag: {item['tag']}")
    for item in images_retained:
        actual = _checked(remote.run(("docker", "image", "inspect", "--format", "{{.Id}}", item["tag"]), 30),
                          f"retained image verification {item['tag']}").stdout.strip()
        require(actual == item["imageId"], f"retained image identity changed: {item['tag']}")

    evidence = {
        "schemaVersion": deployment["schemaVersion"],
        "runnerId": "teamaibox.superseded-feature-cleanup.v1",
        "cleanupId": cleanup_id,
        "status": "passed",
        "target": deployment["target"],
        "composeProject": project,
        "parentEvidence": {
            "path": deployment_path.relative_to(ROOT).as_posix(),
            "digest": digest_bytes(deployment_path.read_bytes()),
        },
        "ownedRunId": run_id,
        "containersRemoved": inventories["containers"],
        "volumesRemoved": inventories["volumes"],
        "networksRemoved": inventories["networks"],
        "imagesRemoved": images_removed,
        "imagesAlreadyAbsent": images_already_absent,
        "sharedImagesRetained": images_retained,
        "stagingPathRemoved": staging,
        "residualProjectResourceCounts": {key: len(value) for key, value in residuals.items()},
        "completedAt": iso_now(),
        "credentialsRetained": False,
        "commandOutputRetained": False,
    }
    if deployment["schemaVersion"] == 2:
        evidence["deploymentPathRemoved"] = deployment_root
    evidence["evidenceDigest"] = digest_bytes(canonical_bytes(evidence))
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, output)
    return evidence


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--cleanup-id", required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    output = (args.output or OUTPUT_ROOT / f"{args.cleanup_id}.json").resolve()
    result = execute_cleanup(args.evidence.resolve(), args.cleanup_id, output)
    print(json.dumps({"cleanupId": result["cleanupId"], "status": result["status"],
                      "sharedImagesRetained": len(result["sharedImagesRetained"]),
                      "evidence": output.relative_to(ROOT).as_posix()}, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (SupersededCleanupError, ValueError, OSError, json.JSONDecodeError) as error:
        print(f"superseded feature cleanup failed: {error}")
        raise SystemExit(1)
