#!/usr/bin/env python3
"""Strictly validate cleanup that preserves image tags still used by successors."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
SHA = re.compile(r"sha256:[0-9a-f]{64}")
FIELDS_V1 = {"schemaVersion", "runnerId", "cleanupId", "status", "target", "composeProject",
    "parentEvidence", "ownedRunId", "containersRemoved", "volumesRemoved", "networksRemoved",
    "imagesRemoved", "imagesAlreadyAbsent", "sharedImagesRetained", "stagingPathRemoved",
    "residualProjectResourceCounts", "completedAt", "credentialsRetained", "commandOutputRetained",
    "evidenceDigest"}
FIELDS_V2 = FIELDS_V1 | {"deploymentPathRemoved"}


class ValidationFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationFailure(message)


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def canonical(value: dict[str, Any]) -> str:
    payload = dict(value); payload.pop("evidenceDigest", None)
    return digest(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())


def validate(path: Path) -> dict[str, Any]:
    resolved = path.resolve(); require(resolved.is_file() and ROOT in resolved.parents, "cleanup evidence is unscoped")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    schema_version = value.get("schemaVersion")
    require(set(value) == (FIELDS_V2 if schema_version == 2 else FIELDS_V1) and schema_version in {1, 2}
        and value.get("runnerId") == "teamaibox.superseded-feature-cleanup.v1"
        and value.get("status") == "passed" and value.get("evidenceDigest") == canonical(value),
        "superseded cleanup identity or digest drifted")
    parent_binding = value.get("parentEvidence", {}); parent = ROOT / parent_binding.get("path", "")
    require(parent.is_file() and parent_binding.get("digest") == digest(parent.read_bytes()), "cleanup parent binding drifted")
    deployment = json.loads(parent.read_text(encoding="utf-8")); project = deployment.get("composeProject")
    require(schema_version == deployment.get("schemaVersion"), "cleanup and deployment schema versions diverged")
    require(value.get("ownedRunId") == deployment.get("runId") and value.get("target") == deployment.get("target")
        and value.get("composeProject") == project, "cleanup ownership drifted")
    require(isinstance(project, str) and value.get("containersRemoved")
        and all(item.startswith(project + "-") for item in value["containersRemoved"]), "container cleanup scope drifted")
    require(value.get("volumesRemoved") and all(item.startswith(project + "_") for item in value["volumesRemoved"]), "volume cleanup scope drifted")
    require(value.get("networksRemoved") and all(item.startswith(project + "_") for item in value["networksRemoved"]), "network cleanup scope drifted")
    require(value.get("stagingPathRemoved") == "/tmp/teamaibox-feature-" + deployment["runId"]
        and value.get("residualProjectResourceCounts") == {"containers": 0, "volumes": 0, "networks": 0},
        "cleanup residual or staging facts drifted")
    if schema_version == 2:
        require(value.get("deploymentPathRemoved") == "/var/lib/teamaibox-feature-deployments/" + deployment["runId"],
                "cleanup durable deployment-path ownership drifted")
    bindings = {(item["buildTag"], item["imageId"]) for item in deployment.get("imageBindings", [])}
    covered = set()
    for key in ("imagesRemoved", "imagesAlreadyAbsent"):
        for item in value.get(key, []):
            require(set(item) == {"tag", "imageId"} and SHA.fullmatch(item["imageId"]), f"{key} entry drifted")
            covered.add((item["tag"], item["imageId"]))
    for item in value.get("sharedImagesRetained", []):
        require(set(item) == {"tag", "imageId", "externalConsumers"} and SHA.fullmatch(item["imageId"])
            and isinstance(item["externalConsumers"], list) and item["externalConsumers"], "retained image entry drifted")
        for consumer in item["externalConsumers"]:
            require(isinstance(consumer, Mapping) and set(consumer) == {"container", "composeProject"}
                and consumer["container"] and consumer["container"] not in value["containersRemoved"], "retained image consumer drifted")
        covered.add((item["tag"], item["imageId"]))
    require(covered == bindings, "cleanup image coverage drifted")
    require(value.get("credentialsRetained") is False and value.get("commandOutputRetained") is False,
        "cleanup retained sensitive output")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(); value = validate(args.evidence)
    print(json.dumps({"cleanupId": value["cleanupId"], "status": "passed",
        "ownedRunId": value["ownedRunId"], "sharedImagesRetained": len(value["sharedImagesRetained"])}, separators=(",", ":")))


if __name__ == "__main__":
    main()
