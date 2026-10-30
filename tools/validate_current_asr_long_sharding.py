#!/usr/bin/env python3
"""Strictly validate the exact current Experimental long-ASR deployment."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

try:
    from .deploy_current_asr_long_sharding import ROOT, REMOTE, RUN_ID, SOURCES, PLATFORM, WORKER, POSTGRES, RUNTIME
    from .run_spark_model_baseline import canonical_digest
except ImportError:
    from deploy_current_asr_long_sharding import ROOT, REMOTE, RUN_ID, SOURCES, PLATFORM, WORKER, POSTGRES, RUNTIME
    from run_spark_model_baseline import canonical_digest


class ValidationError(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise ValidationError(message)


def command(arguments: tuple[str, ...], label: str, timeout: int = 30) -> str:
    result = REMOTE.run(arguments, timeout)
    require(result.returncode == 0, label + " failed")
    return result.stdout


def inspect(name: str) -> dict[str, Any]:
    value = json.loads(command(("sudo", "docker", "inspect", name), "inspect " + name))
    require(isinstance(value, list) and len(value) == 1, name + " inspection drifted")
    return value[0]


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def validate(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    require(resolved.parent == (ROOT / "evidence/validation/feature-deployments").resolve(), "deployment evidence is unscoped")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    run_id = value.get("runId")
    require(value.get("schemaVersion") == 1 and value.get("runnerId") == "teamaibox.current-asr-long-sharding-deployment.v1"
            and isinstance(run_id, str) and RUN_ID.fullmatch(run_id) is not None and resolved.name == run_id + ".json"
            and value.get("status") == "passed" and value.get("failure") is None
            and value.get("componentReady") is True and value.get("productAccepted") is False,
            "deployment identity, result, or claim boundary drifted")
    claimed = value.pop("evidenceDigest", None)
    require(claimed == canonical_digest(value), "deployment evidence digest drifted")
    value["evidenceDigest"] = claimed
    sources = {item.get("path"): item.get("sha256") for item in value.get("sources", []) if isinstance(item, Mapping)}
    require(set(sources) == set(SOURCES), "deployment source matrix drifted")
    for relative in SOURCES:
        require(sources[relative] == digest(ROOT / relative), "deployment source drifted: " + relative)
    tests = value.get("sourceTests", {})
    require(tests.get("passed") is True and tests.get("nodeTests", 0) >= 45 and tests.get("pythonTests") == 2,
            "deployment source tests are incomplete")
    images = value.get("images", {}); profile = value.get("profile", {}); runtime = value.get("runtime", {})
    platform = inspect(PLATFORM); worker = inspect(WORKER)
    require(platform.get("Id") == runtime.get("platform", {}).get("containerId")
            and platform.get("Image") == images.get("platform", {}).get("imageId")
            and platform.get("State", {}).get("Health", {}).get("Status") == "healthy", "live Platform drifted")
    require(worker.get("Id") == runtime.get("worker", {}).get("containerId")
            and worker.get("Image") == images.get("worker", {}).get("imageId") == profile.get("engineImageDigest")
            and worker.get("State", {}).get("Health", {}).get("Status") == "healthy", "live ASR Worker drifted")
    require(images.get("platform", {}).get("flattenedConfigurationMatched") is True
            and str(images.get("platform", {}).get("flattenedBaseImageId", "")).startswith("sha256:"),
            "flattened Platform base evidence is missing")
    require(profile.get("certificationState") == "experimental"
            and profile.get("profileKey", "").startswith("asr.whisper-small.ct2-int8.spark-local.sharded.experimental.")
            and profile.get("profileFingerprint", "").startswith("sha256:")
            and len(profile.get("profileFingerprint", "")) == 71, "Experimental profile evidence drifted")
    row = command(("sudo", "docker", "exec", POSTGRES, "psql", "-U", "teamaibox", "-d", "teamaibox", "-Atc",
        "SELECT profile.profile_key||'|'||encode(registration.profile_fingerprint,'hex')||'|'||profile.certification_state||'|'||(registration.profile_document#>>'{engine,imageDigest}') FROM compute.model_profiles profile JOIN compute.model_profile_registrations registration ON registration.profile_id=profile.id WHERE profile.id='" + profile["profileId"] + "'"),
        "read Experimental profile").strip().split("|")
    require(row == [profile["profileKey"], profile["profileFingerprint"][7:], "experimental", worker["Image"]], "live profile drifted")
    binding = command(("sudo", "docker", "exec", POSTGRES, "psql", "-U", "teamaibox", "-d", "teamaibox", "-Atc",
        "SELECT node.node_key||'|'||capability.capability_key||'|'||binding.availability_state||'|'||(binding.evidence->>'profileId')||'|'||(binding.evidence->>'profileFingerprint')||'|'||(binding.evidence->>'engineImageDigest') FROM compute.node_capabilities binding JOIN compute.nodes node ON node.id=binding.node_id JOIN compute.capabilities capability ON capability.id=binding.capability_id WHERE node.node_key='spark-local' AND capability.capability_key='asr'"),
        "read local ASR node capability").strip().split("|")
    require(binding == ["spark-local", "asr", "available", profile["profileId"],
                        profile["profileFingerprint"], worker["Image"]],
            "live local ASR node capability drifted")
    pins = command(("sudo", "grep", "-E", "^TEAMAIBOX_(CATALOG_PLATFORM_API_IMAGE|BATCH_ASR_IMAGE|ASR_SHARDING_ENABLED|ASR_SHARD_PROFILE_ID|ASR_SHARD_PROFILE_FINGERPRINT)=", RUNTIME), "read runtime pins")
    for expected in ("TEAMAIBOX_CATALOG_PLATFORM_API_IMAGE=" + platform["Image"],
                     "TEAMAIBOX_BATCH_ASR_IMAGE=" + worker["Image"], "TEAMAIBOX_ASR_SHARDING_ENABLED=true",
                     "TEAMAIBOX_ASR_SHARD_PROFILE_ID=" + profile["profileId"],
                     "TEAMAIBOX_ASR_SHARD_PROFILE_FINGERPRINT=" + profile["profileFingerprint"]):
        require(expected in pins, "persistent runtime pin drifted")
    require(runtime.get("minimumShardMediaSeconds") == 90 and runtime.get("targetShardSeconds") == 60
            and runtime.get("overlapSeconds") == 2 and runtime.get("maximumAttemptsPerShard") == 4,
            "runtime sharding policy drifted")
    require(runtime.get("nodeCapability") == {"nodeKey": "spark-local", "capabilityKey": "asr",
                                               "availabilityState": "available"},
            "runtime ASR node-capability evidence drifted")
    require(value.get("blockers") == ["release-candidate long-ASR quality/soak", "physical 10GbE two-node ASR",
                                       "independent human acceptance"], "deployment blockers drifted")
    require(value.get("cleanup") == {"runRootRemoved": True, "baseTagsRemoved": True,
                                      "failedCandidateTagsRemoved": None,
                                      "candidatePlatformAbsent": True,
                                      "previousPlatformAbsent": True}, "deployment cleanup drifted")
    return {"valid": True, "runId": run_id, "evidenceDigest": claimed,
            "platformImageId": platform["Image"], "workerImageId": worker["Image"],
            "profileFingerprint": profile["profileFingerprint"], "productAccepted": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    print(json.dumps(validate(parser.parse_args().evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationError, OSError, ValueError, json.JSONDecodeError) as error:
        print("Current ASR long-sharding evidence invalid: " + str(error))
        raise SystemExit(1)
