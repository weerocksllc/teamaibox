#!/usr/bin/env python3
"""Validate the closed production ARM64 image build catalog."""

from __future__ import annotations

import json
import hashlib
from pathlib import Path, PurePosixPath
import re
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "architecture/validation/production-image-catalog.v1.json"
SHA_REF = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$")
SAFE_KEY = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
REQUIRED_COMPONENTS = {
    "web-boundary", "platform-api", "postgres", "event-bus", "object-service", "scheduler",
    "node-agent", "plugin-runtime", "agent-bridge", "messaging", "source-gateways", "observability",
    "compute-gateway", "appliance-gateway",
}
REQUIRED_EVIDENCE = {
    "sourceDigest", "ociDigest", "arm64Inspection", "nonRootInspection", "healthCheck",
    "resourceLimitInspection", "spdxSbomDigest", "cosignVerification", "provenanceVerification",
}
NODE_SERVICES = {
    "object-service": "object-service",
    "scheduler": "scheduler",
    "plugin-runtime": "plugin-runtime",
    "agent-bridge": "agent-bridge",
    "messaging": "messaging",
    "source-gateways": "source-gateway",
    "observability": "observability",
}


class ProductionImageCatalogError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ProductionImageCatalogError(message)


def safe_file(value: Any) -> Path:
    require(isinstance(value, str) and value.startswith("deploy/images/"), "Dockerfile path is invalid")
    pure = PurePosixPath(value)
    require(not pure.is_absolute() and ".." not in pure.parts and pure.name.endswith("Dockerfile"),
            "Dockerfile path escapes the repository")
    path = ROOT / pure
    require(path.is_file(), "Dockerfile is missing: " + value)
    return path


def validate(value: Mapping[str, Any]) -> dict[str, int]:
    require(value.get("schemaVersion") == 1 and value.get("catalogId") == "teamaibox.production-images.v1",
            "production image catalog identity drifted")
    require(value.get("architecture") == "linux/arm64/v8", "production images must be ARM64/v8")
    require(value.get("buildNetwork") == "host-for-dependency-fetch-only"
            and value.get("runtimeNetwork") == "compose-isolated",
            "build-host networking must never become the runtime network")
    require(value.get("sourceDateEpochRequired") is True
            and value.get("immutableRegistryDigestRequired") is True,
            "reproducible immutable production images are required")
    supply = value.get("supplyChain")
    require(isinstance(supply, Mapping), "supply-chain declaration is missing")
    require(supply.get("sbomFormat") == "spdx-json" and supply.get("sbomTool") == "syft"
            and supply.get("sbomVersion") == "1.50.0", "SPDX/Syft policy drifted")
    require(supply.get("signatureTool") == "cosign" and supply.get("signatureVersion") == "3.0.6"
            and supply.get("provenance") == "slsa-v1", "Cosign/provenance policy drifted")
    for field in ("signatureArm64Image", "sbomArm64Image"):
        require(SHA_REF.fullmatch(str(supply.get(field, ""))) is not None, field + " is not digest pinned")

    components = value.get("components")
    require(isinstance(components, list) and len(components) == len(REQUIRED_COMPONENTS),
            "production image component count drifted")
    keys: set[str] = set()
    for item in components:
        require(isinstance(item, Mapping) and set(item) == {
            "key", "dockerfile", "buildArguments", "runtimeUser", "healthPath",
            "memoryLimitBytes", "cpuLimit",
        }, "production image component fields drifted")
        key = item["key"]
        require(isinstance(key, str) and SAFE_KEY.fullmatch(key) is not None and key not in keys,
                "production image key is invalid or duplicated")
        keys.add(key)
        source = safe_file(item["dockerfile"]).read_text(encoding="utf-8")
        require("foundation-node.Dockerfile" not in item["dockerfile"] and "foundation-stub" not in source,
                key + " cannot use a foundation stub")
        require("HEALTHCHECK" in source, key + " Dockerfile has no health check")
        require(f"USER {item['runtimeUser']}" in source, key + " Dockerfile runtime user drifted")
        require(item["runtimeUser"] not in {"0", "0:0", "root", "root:root"}, key + " must be non-root")
        require(isinstance(item["healthPath"], str) and item["healthPath"], key + " health path is missing")
        require(isinstance(item["memoryLimitBytes"], int) and item["memoryLimitBytes"] >= 268_435_456,
                key + " memory limit is missing")
        require(isinstance(item["cpuLimit"], (int, float)) and 0 < item["cpuLimit"] <= 4,
                key + " CPU limit is missing")
        arguments = item["buildArguments"]
        require(isinstance(arguments, Mapping), key + " build arguments are invalid")
        expected_service = NODE_SERVICES.get(key)
        if expected_service:
            require(item["dockerfile"] == "deploy/images/production-node-service.Dockerfile"
                    and arguments == {"SERVICE_NAME": expected_service}, key + " service image binding drifted")
        else:
            require(arguments == {}, key + " has undeclared build arguments")
        if key == "postgres":
            manifest = ROOT / "packages/persistence/migrations/manifest.json"
            checksum = hashlib.sha256(manifest.read_bytes()).hexdigest()
            require(f"ARG MIGRATION_MANIFEST_SHA256={checksum}" in source
                    and "ENV TEAMAIBOX_MIGRATION_MANIFEST_SHA256=${MIGRATION_MANIFEST_SHA256}" in source
                    and "teamaibox-apply-migrations" in source,
                    "PostgreSQL image does not bind its fail-closed migration manifest")
    require(keys == REQUIRED_COMPONENTS, "production image catalog coverage drifted")
    completion = value.get("completionEvidence")
    require(isinstance(completion, Mapping)
            and set(completion.get("requiredPerComponent", [])) == REQUIRED_EVIDENCE
            and completion.get("taskMayCloseWithoutExactEvidence") is False,
            "production image completion evidence gate drifted")
    return {"components": len(keys), "supplyChainTools": 2, "requiredEvidencePerComponent": len(REQUIRED_EVIDENCE)}


def main() -> int:
    result = validate(json.loads(CATALOG.read_text(encoding="utf-8")))
    print(json.dumps({**result, "valid": True}, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
