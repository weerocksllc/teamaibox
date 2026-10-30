#!/usr/bin/env python3
"""Validate CI action pins, image locks, and release supply-chain gates."""

from __future__ import annotations

import json
import pathlib
import re
from typing import Any, Mapping


ROOT = pathlib.Path(__file__).resolve().parents[1]
POLICY = ROOT / "deploy" / "supply-chain" / "policy.v1.json"
ACTIONS = ROOT / "deploy" / "supply-chain" / "actions.lock.json"
IMAGES = ROOT / "deploy" / "compose" / "images.arm64.json"
WORKFLOWS = ROOT / ".github" / "workflows"
FOUNDATION_DOCKERFILE = ROOT / "deploy" / "images" / "foundation-node.Dockerfile"
USE = re.compile(r"^\s*(?:-\s*)?uses:\s*([^@\s]+)@([^\s#]+)", re.MULTILINE)
SHA = re.compile(r"^[a-f0-9]{40}$")
DIGEST_REF = re.compile(r"^[^\s@]+@sha256:[a-f0-9]{64}$")


class SupplyChainError(ValueError):
    pass


def validate(
    policy: Mapping[str, Any],
    actions: Mapping[str, Any],
    images: Mapping[str, Any],
    workflows: Mapping[str, str],
) -> dict[str, int]:
    if policy.get("policyVersion") != 1:
        raise SupplyChainError("supply-chain policy version must be 1")
    release = policy.get("release")
    build = policy.get("build")
    if not isinstance(release, Mapping) or not isinstance(build, Mapping):
        raise SupplyChainError("release and build supply-chain policy are required")
    for field in ("digestReferenceRequired", "signaturesRequired", "sbomRequired", "provenanceRequired"):
        if release.get(field) is not True:
            raise SupplyChainError("release policy must require " + field)
    if release.get("signatureTool") != "cosign" or release.get("identityMatching") != "exact":
        raise SupplyChainError("release signatures must use exact-identity Cosign verification")
    if release.get("keylessIssuer") != "https://token.actions.githubusercontent.com":
        raise SupplyChainError("release keyless issuer is invalid")
    if build.get("requiredPlatforms") != ["linux/arm64/v8"]:
        raise SupplyChainError("Linux ARM64/v8 must be the required build platform")
    if not DIGEST_REF.fullmatch(str(build.get("buildkitImage", ""))):
        raise SupplyChainError("BuildKit image must be digest pinned")
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", str(build.get("buildkitRelease", ""))):
        raise SupplyChainError("BuildKit release must be an exact version")
    if build.get("sourceDateEpochRequired") is not True or build.get("independentBuildCount", 0) < 2:
        raise SupplyChainError("reproducible builds require SOURCE_DATE_EPOCH and two builds")
    required_gates = {
        "manifest-lint", "database-migrations", "api-schema", "secret-scan",
        "arm64-build", "sbom", "signature-verification", "reproducible-digest",
    }
    if set(policy.get("gates", [])) != required_gates:
        raise SupplyChainError("supply-chain gate list is incomplete")

    if actions.get("schemaVersion") != 1 or not isinstance(actions.get("actions"), list):
        raise SupplyChainError("GitHub Action lock is invalid")
    action_locks: dict[str, str] = {}
    for item in actions["actions"]:
        if not isinstance(item, Mapping):
            raise SupplyChainError("GitHub Action lock entry must be an object")
        name = item.get("name")
        commit = item.get("commit")
        if not isinstance(name, str) or name in action_locks or not SHA.fullmatch(str(commit)):
            raise SupplyChainError("GitHub Action name or commit is invalid")
        if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", str(item.get("release", ""))):
            raise SupplyChainError("GitHub Action release must be an exact version")
        action_locks[name] = str(commit)

    used: set[str] = set()
    for filename, source in workflows.items():
        for name, revision in USE.findall(source):
            if not SHA.fullmatch(revision):
                raise SupplyChainError(f"{filename} uses mutable action revision: {name}@{revision}")
            if action_locks.get(name) != revision:
                raise SupplyChainError(f"{filename} uses an unlocked action: {name}@{revision}")
            used.add(name)
    if set(action_locks) != used:
        raise SupplyChainError("action lock contains unused or workflow usage lacks an action")

    if images.get("architecture") != "linux/arm64/v8" or not isinstance(images.get("images"), Mapping):
        raise SupplyChainError("ARM64 image lock is invalid")
    for name, image in images["images"].items():
        if not isinstance(image, Mapping) or not DIGEST_REF.fullmatch(str(image.get("reference", ""))):
            raise SupplyChainError(name + " is not pinned to a platform digest")
        if image.get("reference", "").endswith(str(image.get("indexDigest", ""))):
            raise SupplyChainError(name + " must select its ARM64 manifest rather than only the index")
    dockerfile = FOUNDATION_DOCKERFILE.read_text(encoding="utf-8")
    expected_base = "ARG NODE_IMAGE=" + images["images"]["node-runtime"]["reference"]
    if expected_base not in dockerfile:
        raise SupplyChainError("foundation Dockerfile default does not match the locked Node image")

    combined = "\n".join(workflows.values())
    required_commands = (
        "validate_module_layout.py",
        "validate_migrations.py",
        "validate_interface_contracts.py",
        "scan_secrets.py",
        "ci_database_smoke.py",
        "--platform linux/arm64/v8",
        str(build["buildkitImage"]),
        "compare_oci_digests.py",
        "anchore/sbom-action",
        "cosign verify",
        "cosign verify-attestation",
        "--type spdxjson",
        "--type slsaprovenance1",
    )
    for command in required_commands:
        if command not in combined:
            raise SupplyChainError("CI workflow is missing gate: " + command)
    return {"actions": len(action_locks), "workflows": len(workflows), "images": len(images["images"])}


def main() -> int:
    policy = json.loads(POLICY.read_text(encoding="utf-8"))
    actions = json.loads(ACTIONS.read_text(encoding="utf-8"))
    images = json.loads(IMAGES.read_text(encoding="utf-8"))
    workflows = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(WORKFLOWS.glob("*.yml"))
    }
    summary = validate(policy, actions, images, workflows)
    print(
        "supply chain valid: "
        f"{summary['actions']} pinned actions, {summary['workflows']} workflows, "
        f"{summary['images']} ARM64 image locks"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
