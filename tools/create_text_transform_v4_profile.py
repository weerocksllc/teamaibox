#!/usr/bin/env python3
"""Create the immutable, freshly rebuilt and conformance-tested text-transform v4 profile."""

from __future__ import annotations

import base64
import copy
import hashlib
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "deploy/application-catalog-e2e/text-transform-managed-node-v3.certified.v1.json"
PROFILE = ROOT / "deploy/application-catalog-e2e/text-transform-managed-node-v4.certified.v1.json"
ADVERTISEMENT = ROOT / "deploy/application-catalog-e2e/text-transform-managed-node-v4-advertisement.v1.json"
IMAGE_EVIDENCE = ROOT / "evidence/validation/plugins/plugin-images-20260819-a3.json"
CONFORMANCE_EVIDENCE = ROOT / "evidence/validation/model-profiles/text-transform-v4-conformance-20260819-a1.json"
PROFILE_ID = "1bec1694-44be-573a-a4f5-99f18e27d898"
PROFILE_KEY = "compute.text-transform.deterministic.arm64.v4"


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def main() -> None:
    if PROFILE.exists() or ADVERTISEMENT.exists():
        raise SystemExit("v4 profile artifacts already exist and are immutable")
    image_bytes = IMAGE_EVIDENCE.read_bytes()
    image_evidence = json.loads(image_bytes)
    conformance_bytes = CONFORMANCE_EVIDENCE.read_bytes()
    conformance = json.loads(conformance_bytes)
    if image_evidence.get("status") != "passed" or image_evidence.get("runId") != "plugin-images-20260819-a3":
        raise SystemExit("exact successful v4 image evidence is required")
    if conformance.get("status") != "passed" or conformance.get("profileId") != PROFILE_ID:
        raise SystemExit("exact successful v4 conformance evidence is required")
    image = next(item for item in image_evidence["images"] if item["key"] == "text-transform-v1")
    if conformance.get("imageReference") != image["reference"] or conformance.get("imageId") != image["imageId"]:
        raise SystemExit("v4 image and conformance evidence do not bind the same artifact")
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
    observed_at = conformance["completedAt"]
    profile = copy.deepcopy(json.loads(SOURCE.read_text(encoding="utf-8")))
    profile.update({
        "profileId": PROFILE_ID,
        "profileKey": PROFILE_KEY,
        "artifactDigest": image["digest"],
        "createdAt": observed_at,
    })
    profile["source"]["revision"] = source_digest.removeprefix("sha256:")
    profile["source"]["provenance"].update({
        "retrievedAt": image_evidence["startedAt"],
        "sourceDigest": source_digest,
        "evidenceRef": "evidence://validation/plugins/plugin-images-20260819-a3",
    })
    profile["artifacts"][0].update({
        "digest": image["digest"],
        "sizeBytes": len(base64.b64decode(image["manifestBase64"])),
    })
    profile["engine"].update({
        "version": "1.3.0",
        "runtimeVersion": "24.15.0",
        "imageDigest": image["digest"],
    })
    conformance_digest = digest(conformance_bytes)
    profile["validationEvidence"] = [
        {
            "stage": stage,
            "result": "passed",
            "runId": f"{conformance['runId']}-{stage}",
            "evidenceRef": "evidence://validation/model-profiles/text-transform-v4-conformance-20260819-a1",
            "observedAt": observed_at,
            "environmentDigest": conformance_digest,
        }
        for stage in ("conformance", "security")
    ]
    profile["certification"] = {
        "state": "certified",
        "evidenceRefs": [
            "evidence://validation/plugins/plugin-images-20260819-a3",
            "evidence://validation/model-profiles/text-transform-v4-conformance-20260819-a1",
        ],
    }
    profile["knownLimitations"] = [
        "This deterministic uppercase worker certifies managed-node Worker-Control and container isolation only; it is not an AI model and makes no model-quality, GPU, NVFP4, or 10GbE claim."
    ]
    PROFILE.write_text(json.dumps(profile, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    script = """
import { readFile } from 'node:fs/promises';
import { modelProfileFingerprintV1 } from './apps/platform-api/src/models/model-profile-registration-service.mjs';
const value=JSON.parse(await readFile(process.argv[1],'utf8'));
const {schemaVersion,profileId,certification,createdAt,...declaration}=value;
process.stdout.write(modelProfileFingerprintV1(declaration));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "--eval", script, str(PROFILE)],
        cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode != 0 or not result.stdout.startswith("sha256:"):
        PROFILE.unlink(missing_ok=True)
        raise SystemExit("v4 profile fingerprint calculation failed")
    advertisement = {
        "profileId": PROFILE_ID,
        "profileKey": PROFILE_KEY,
        "profileFingerprint": result.stdout,
        "operations": ["responses"],
        "capabilityKey": "text-transform",
        "evidenceDigest": conformance_digest,
    }
    ADVERTISEMENT.write_text(json.dumps(advertisement, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "profile": PROFILE.relative_to(ROOT).as_posix(),
        "advertisement": ADVERTISEMENT.relative_to(ROOT).as_posix(),
        "fingerprint": result.stdout,
        "artifactDigest": image["digest"],
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
