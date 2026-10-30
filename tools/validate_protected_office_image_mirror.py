#!/usr/bin/env python3
"""Strictly validate an immutable protected-office image mirror run."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DECLARATION = ROOT / "deploy/compute/protected-office-image-mirror.v1.json"
RUN_ID = re.compile(r"^protected-office-image-mirror-[0-9]{8}-a[1-9][0-9]*$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")


class ValidationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def digest(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def canonical_digest(value: dict[str, Any]) -> str:
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()
    path = Path(args.evidence).resolve()
    expected_root = (ROOT / "evidence/validation/supply-chain").resolve()
    require(path.is_relative_to(expected_root) and path.is_file(), "evidence path is outside the supply-chain root")
    report = json.loads(path.read_text(encoding="utf-8"))
    recorded = report.pop("evidenceDigest", None)
    require(SHA256.fullmatch(str(recorded or "")) is not None
            and recorded == canonical_digest(report), "evidence digest drifted")
    report["evidenceDigest"] = recorded
    require(report.get("schemaVersion") == 1
            and report.get("runnerId") == "teamaibox.protected-office-image-mirror.v1"
            and RUN_ID.fullmatch(str(report.get("runId", ""))) is not None
            and path.name == report["runId"] + ".json"
            and report.get("status") == "passed" and report.get("failure") is None,
            "mirror run identity or status is invalid")
    declaration = json.loads(DECLARATION.read_text(encoding="utf-8"))
    expected_sources = {
        "deploy/compute/protected-office-image-mirror.v1.json": digest(DECLARATION.read_bytes()),
        "tools/mirror_protected_office_images.py": digest((ROOT / "tools/mirror_protected_office_images.py").read_bytes()),
        "tools/validate_protected_office_image_mirror.py": digest((ROOT / "tools/validate_protected_office_image_mirror.py").read_bytes()),
        "tests/test_protected_office_image_mirror.py": digest((ROOT / "tests/test_protected_office_image_mirror.py").read_bytes()),
    }
    bindings = report.get("sourceBindings")
    require(isinstance(bindings, list)
            and {item.get("path"): item.get("sha256") for item in bindings} == expected_sources,
            "mirror source binding drifted")
    require(report.get("target") == declaration["target"], "mirror target drifted")
    registry = report.get("registry")
    require(isinstance(registry, dict)
            and registry.get("containerName") == declaration["registry"]["containerName"]
            and re.fullmatch(r"[0-9a-f]{64}", str(registry.get("containerId", ""))) is not None
            and registry.get("imageId") == declaration["registry"]["imageId"]
            and registry.get("repositoryDigest") == declaration["registry"]["repositoryDigest"]
            and registry.get("api") == declaration["registry"]["api"]
            and registry.get("dockerAuthority") == declaration["registry"]["dockerAuthority"]
            and registry.get("state") == "running", "registry identity drifted")
    expected = {item["key"]: item for item in declaration["images"]}
    images = report.get("images")
    require(isinstance(images, list) and len(images) == len(expected)
            and {item.get("key") for item in images} == set(expected),
            "mirrored image set drifted")
    for image in images:
        declared = expected[image["key"]]
        prefix = f'{declaration["registry"]["dockerAuthority"]}/{declared["repository"]}@'
        require(image.get("sourceImageId") == declared["sourceImageId"]
                and image.get("configDigest") == declared["sourceImageId"]
                and isinstance(image.get("imageReference"), str)
                and image["imageReference"].startswith(prefix)
                and image.get("manifestDigest") == image["imageReference"].rsplit("@", 1)[1]
                and SHA256.fullmatch(str(image.get("manifestDigest", ""))) is not None
                and image.get("publishedTag") ==
                    f'{declaration["registry"]["dockerAuthority"]}/{declared["repository"]}:{report["runId"]}'
                and image.get("platform") == "linux/arm64/v8"
                and isinstance(image.get("manifestBytes"), int) and image["manifestBytes"] > 0
                and isinstance(image.get("layerCount"), int) and image["layerCount"] > 0,
                image["key"] + " immutable OCI identity is invalid")
    require(report.get("credentialsRetained") is False
            and report.get("commandOutputRetained") is False
            and report.get("workerMutationPerformed") is False
            and report.get("modelLoadPerformed") is False
            and report.get("productRouteChanged") is False
            and report.get("task21_4Complete") is False
            and report.get("claimBoundary") == declaration["claimBoundary"],
            "mirror claim boundary or secret handling drifted")
    print(json.dumps({
        "runId": report["runId"], "status": "passed", "evidenceDigest": recorded,
        "imageCount": len(images), "task21_4Complete": False,
    }, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationError, OSError, json.JSONDecodeError) as error:
        print(f"Protected office image mirror validation failed: {error}")
        raise SystemExit(1)
