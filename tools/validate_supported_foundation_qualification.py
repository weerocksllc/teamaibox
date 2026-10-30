#!/usr/bin/env python3
"""Strictly validate immutable supported-foundation qualification evidence."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any, Sequence


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.appliance_operations import canonical_digest, digest_bytes
from tools.run_supported_foundation_qualification import EXPECTED_EXITED, ROUTES
from tools.validate_feature_arm64_deployment_evidence import validate_deployment


RUNNER = ROOT / "tools/run_supported_foundation_qualification.py"


class ValidationFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationFailure(message)


def validate(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    require(resolved.is_file() and ROOT in resolved.parents, "supported-foundation evidence is missing or unsafe")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    require(value.get("schemaVersion") == 1
            and value.get("runnerId") == "teamaibox.supported-foundation-qualification.v1"
            and value.get("status") == "passed", "supported-foundation identity or status drifted")
    payload = dict(value); claimed = payload.pop("evidenceDigest", None)
    require(claimed == canonical_digest(payload), "supported-foundation evidence digest drifted")
    require(value.get("source") == {"runnerDigest": digest_bytes(RUNNER.read_bytes())}, "supported-foundation runner drifted")
    parent_ref, plan_ref = value.get("parent", {}), value.get("plan", {})
    parent_path, plan_path = ROOT / str(parent_ref.get("path", "")), ROOT / str(plan_ref.get("path", ""))
    require(parent_path.is_file() and plan_path.is_file()
            and parent_ref.get("digest") == digest_bytes(parent_path.read_bytes())
            and plan_ref.get("digest") == digest_bytes(plan_path.read_bytes()), "supported-foundation parent binding drifted")
    parent, plan = json.loads(parent_path.read_text(encoding="utf-8")), json.loads(plan_path.read_text(encoding="utf-8"))
    validate_deployment(parent, plan)
    require(parent_ref.get("runId") == parent.get("runId") == "encryption-suite-20260822-a356"
            and value.get("composeProject") == parent.get("composeProject")
            and value.get("deploymentRoot") == parent.get("deploymentRoot")
            and parent.get("deploymentRootRetained") is True, "supported-foundation deployment identity drifted")
    expected_services = set(plan["dependencyServices"]) | set(plan["featureServices"]) | {"secret-init", "database-migrate"}
    containers = value.get("containers", [])
    require(len(containers) == len(expected_services) and {item.get("service") for item in containers} == expected_services,
            "supported-foundation service coverage drifted")
    allowed_images = {item["imageId"] for item in parent["imageBindings"]}
    for item in containers:
        require(item.get("imageId") in allowed_images and item.get("networkMode") != "host", "container image or network drifted")
        if item["service"] in EXPECTED_EXITED:
            require(item.get("state") == "exited" and item.get("exitCode") == 0, "one-shot container did not pass")
        else:
            require(item.get("state") == "running" and item.get("health") == "healthy", "runtime container is not healthy")
    images = value.get("images", [])
    require(images and {item.get("imageId") for item in images} == {item["imageId"] for item in containers}
            and all(item.get("architecture") == "arm64" and item.get("os") == "linux" for item in images),
            "supported-foundation ARM64 image coverage drifted")
    routes = value.get("routes", [])
    require({item.get("path"): {"method": item.get("method"), "status": item.get("status")} for item in routes} == ROUTES
            and all(re.fullmatch(r"sha256:[0-9a-f]{64}", str(item.get("bodyDigest", ""))) for item in routes),
            "supported-foundation route matrix drifted")
    require(value.get("stalePreviewPorts") == [{"port": 18080, "httpStatus": 0}, {"port": 18081, "httpStatus": 0}],
            "stale preview entry remains")
    require(value.get("tls", {}).get("browserTrusted") is False
            and value.get("limitations") == {
                "browserTrustedHttps": "not_satisfied_self_signed_component_certificate",
                "independentHumanAcceptance": "not_performed",
                "physical10GbEAsr": "not_satisfied_observed_1GbE",
                "usbSdkDevice": "not_available_not_claimed",
                "activeMediaLuksMigration": "not_performed_disposable_luks2_only",
            }, "supported-foundation limitation boundary drifted")
    require(value.get("unrelatedContainerInventoryDigestBefore") == value.get("unrelatedContainerInventoryDigestAfter")
            and value.get("credentialsRetained") is False and value.get("commandOutputRetained") is False,
            "qualification changed unrelated containers or retained sensitive output")
    return {"valid": True, "runId": value["runId"], "parentRunId": parent["runId"],
            "containerCount": len(containers), "imageCount": len(images), "routeCount": len(routes)}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationFailure, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"supported foundation evidence invalid: {error}")
        raise SystemExit(1)
