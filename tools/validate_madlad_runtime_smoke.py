#!/usr/bin/env python3
"""Validate the exact MADLAD artifact/runtime smoke evidence and immutable profile."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / "models/profiles/madlad400-3b-mt-bf16-spark.v1.json"
EXPECTED_FINGERPRINT = "sha256:faf67c329e8a4f3bdfe257a580169004fa06e0b07bea30ab4859a1d970e3fdbe"
SHA = re.compile(r"^sha256:[a-f0-9]{64}$")


def canonical_digest(value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def validate(evidence: dict[str, object], profile: dict[str, object]) -> None:
    payload = dict(evidence)
    claimed = payload.pop("evidenceDigest", None)
    require(SHA.fullmatch(str(claimed)) is not None and claimed == canonical_digest(payload), "runtime evidence digest drifted")
    require(evidence.get("schemaVersion") == 1 and evidence.get("runner") == "teamaibox.capture-madlad-runtime-smoke.v1", "runtime evidence identity drifted")
    require(evidence.get("runId") == "madlad400-runtime-smoke-20260813-a1" and evidence.get("outcome") == "passed", "runtime run or outcome drifted")
    require(evidence.get("candidateId") == "madlad400-3b-mt-bf16" and evidence.get("certificationClaimEligible") is False, "runtime candidate claim drifted")
    artifact = evidence.get("artifact") or {}
    require(artifact == {
        "repository": "google/madlad400-3b-mt", "revision": "fa184c675da0b5c9e1c8694fccd4e12e2d422094",
        "artifactDigest": "sha256:ab6f3caf9681bfbb826c0fe7a93a64345a37bf1e6005b16d0f984623686842e1",
        "totalBytes": 11782646886, "fileCount": 8,
    }, "runtime artifact binding drifted")
    engine = evidence.get("engine") or {}
    require(engine.get("registryManifestDigest") == profile.get("engine", {}).get("imageDigest"), "runtime engine/profile image drifted")
    require(engine.get("sourceDigest") == profile.get("extensions", {}).get("worker_source_digest"), "runtime worker source drifted")
    dtype_to_precision = {"bfloat16": "bf16", "float32": "fp32"}
    require(dtype_to_precision.get(engine.get("dtype")) == profile.get("precision") == "bf16", "runtime precision drifted")
    require(artifact.get("artifactDigest") == profile.get("artifactDigest"), "runtime profile artifact drifted")
    boundary = evidence.get("containerBoundary") or {}
    require(boundary.get("running") is True and boundary.get("oomKilled") is False and boundary.get("readOnlyRootfs") is True, "runtime boundary health drifted")
    require(boundary.get("capDrop") == ["ALL"] and boundary.get("securityOpt") == ["no-new-privileges"], "runtime sandbox drifted")
    require(boundary.get("artifactDigest") == artifact.get("artifactDigest") and boundary.get("sourceDigest") == engine.get("sourceDigest"), "runtime container binding drifted")
    api = evidence.get("apiChecks") or {}
    require(api == {"aligned": True, "invalidModelStatus": 400, "requiredSyntheticTokensPreserved": True,
                    "successStatus": 200, "translationCount": 2}, "runtime API checks drifted")
    privacy = evidence.get("privacy") or {}
    require(privacy == {"syntheticInputOnly": True, "inputOrOutputTextRetained": False, "credentialsRetained": False}, "runtime privacy facts drifted")
    require(evidence.get("environmentDigest") == canonical_digest(evidence.get("environment")), "runtime environment digest drifted")
    completed = subprocess.run([
        "node", "--input-type=module", "-e",
        "import {modelProfileFingerprintV1 as f} from './apps/platform-api/src/models/model-profile-registration-service.mjs';"
        "let b='';for await(const c of process.stdin)b+=c;process.stdout.write(f(JSON.parse(b)));",
    ], cwd=ROOT, input=json.dumps(profile), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    require(completed.returncode == 0, "MADLAD profile no longer passes registration validation")
    require(completed.stdout == EXPECTED_FINGERPRINT, "MADLAD profile fingerprint drifted")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--profile", type=Path, default=PROFILE)
    args = parser.parse_args()
    validate(json.loads(args.evidence.read_text(encoding="utf-8")), json.loads(args.profile.read_text(encoding="utf-8")))
    print(json.dumps({"outcome": "passed", "profileFingerprint": EXPECTED_FINGERPRINT, "evidence": str(args.evidence)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
