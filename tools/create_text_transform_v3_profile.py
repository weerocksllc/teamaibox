#!/usr/bin/env python3
"""Create the immutable cancellation-capable text-transform v3 profile."""

from __future__ import annotations

import base64
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "deploy/application-catalog-e2e/text-transform-managed-node-v2.certified.v1.json"
PROFILE = ROOT / "deploy/application-catalog-e2e/text-transform-managed-node-v3.certified.v1.json"
ADVERTISEMENT = ROOT / "deploy/application-catalog-e2e/text-transform-managed-node-v3-advertisement.v1.json"
IMAGE_EVIDENCE = ROOT / "evidence/validation/plugin-sources/plugin-images-20260815-a2.json"
PROFILE_ID = "32edf12a-2678-51bf-98e3-05435fa814c7"
PROFILE_KEY = "compute.text-transform.deterministic.arm64.v3"


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def main() -> None:
    if PROFILE.exists() or ADVERTISEMENT.exists():
        raise SystemExit("v3 profile artifacts already exist and are immutable")
    evidence_bytes = IMAGE_EVIDENCE.read_bytes()
    evidence = json.loads(evidence_bytes)
    if evidence.get("status") != "passed" or evidence.get("runId") != "plugin-images-20260815-a2":
        raise SystemExit("exact successful v3 image evidence is required")
    image = next(item for item in evidence["images"] if item["key"] == "text-transform-v1")
    source_hash = hashlib.sha256()
    for name in (
        "packages/plugin-sdk/src/worker-control-v1.mjs",
        "examples/plugins/text-transform-worker/src/worker.mjs",
        "examples/plugins/text-transform-worker/src/server.mjs",
        "examples/plugins/text-transform-worker/Dockerfile",
    ):
        payload = (ROOT / name).read_bytes()
        source_hash.update(name.encode() + b"\0" + hashlib.sha256(payload).digest())
    source_digest = "sha256:" + source_hash.hexdigest()
    evidence_digest = digest(evidence_bytes)
    observed_at = evidence["startedAt"]
    profile = copy.deepcopy(json.loads(SOURCE.read_text(encoding="utf-8")))
    profile.update({
        "profileId": PROFILE_ID,
        "profileKey": PROFILE_KEY,
        "artifactDigest": image["digest"],
        "createdAt": observed_at,
    })
    profile["source"]["revision"] = source_digest.removeprefix("sha256:")
    profile["source"]["provenance"].update({
        "retrievedAt": observed_at,
        "sourceDigest": source_digest,
        "evidenceRef": "evidence://plugin-sources/plugin-images-20260815-a2",
    })
    profile["artifacts"][0]["digest"] = image["digest"]
    profile["artifacts"][0]["sizeBytes"] = len(base64.b64decode(image["manifestBase64"]))
    profile["engine"].update({
        "version": "1.2.0",
        "runtimeVersion": "24.15.0",
        "imageDigest": image["digest"],
    })
    profile["limits"]["maximumDurationSeconds"] = 10
    for index, stage in enumerate(("conformance", "security"), start=1):
        profile["validationEvidence"][index - 1] = {
            "stage": stage,
            "result": "passed",
            "runId": f"plugin-images-20260815-a2-sdk-{stage}",
            "evidenceRef": "evidence://plugin-sources/plugin-images-20260815-a2",
            "observedAt": observed_at,
            "environmentDigest": evidence_digest,
        }
    profile["certification"] = {
        "state": "certified",
        "evidenceRefs": ["evidence://plugin-sources/plugin-images-20260815-a2"],
    }
    profile["knownLimitations"] = [
        "This deterministic uppercase worker certifies managed-node Worker-Control, warm reuse, and cooperative cancellation only; it is not an AI model and makes no model-quality, GPU, NVFP4, or 10GbE claim."
    ]
    PROFILE.write_text(json.dumps(profile, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    script = """
import { readFile } from 'node:fs/promises';
import { modelProfileFingerprintV1 } from './apps/platform-api/src/models/model-profile-registration-service.mjs';
const value=JSON.parse(await readFile(process.argv[1],'utf8'));
const {schemaVersion,profileId,certification,createdAt,...declaration}=value;
process.stdout.write(modelProfileFingerprintV1(declaration));
"""
    result = subprocess.run(["node", "--input-type=module", "--eval", script, str(PROFILE)], cwd=ROOT,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0 or not result.stdout.startswith("sha256:"):
        PROFILE.unlink(missing_ok=True)
        raise SystemExit("v3 profile fingerprint calculation failed")
    advertisement = {
        "profileId": PROFILE_ID,
        "profileKey": PROFILE_KEY,
        "profileFingerprint": result.stdout,
        "operations": ["responses"],
        "capabilityKey": "text-transform",
        "evidenceDigest": evidence_digest,
    }
    ADVERTISEMENT.write_text(json.dumps(advertisement, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"profile": str(PROFILE.relative_to(ROOT)),
                      "advertisement": str(ADVERTISEMENT.relative_to(ROOT)),
                      "fingerprint": result.stdout}, separators=(",", ":")))


if __name__ == "__main__":
    main()
