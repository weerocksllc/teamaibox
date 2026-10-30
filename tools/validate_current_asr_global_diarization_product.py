#!/usr/bin/env python3
"""Strictly validate one exact current Experimental ASR/global-diarization deployment."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Mapping

try:
    from .deploy_current_asr_global_diarization_product import (
        ASR_PLUGIN, ASR_WORKER, DIARIZATION_PROFILE_DIGEST, DIARIZATION_PROFILE_KEY,
        DIARIZATION_WORKER, MIGRATION_SHA256, MIGRATION_VERSION, PARENTS, PLATFORM,
        POSTGRES, PROFILE_KEY, ROOT, RUN_ID, RUNTIME, SOURCES, command, digest, inspect,
        parent, source_tests,
    )
    from .run_spark_model_baseline import canonical_digest
except ImportError:
    from deploy_current_asr_global_diarization_product import (
        ASR_PLUGIN, ASR_WORKER, DIARIZATION_PROFILE_DIGEST, DIARIZATION_PROFILE_KEY,
        DIARIZATION_WORKER, MIGRATION_SHA256, MIGRATION_VERSION, PARENTS, PLATFORM,
        POSTGRES, PROFILE_KEY, ROOT, RUN_ID, RUNTIME, SOURCES, command, digest, inspect,
        parent, source_tests,
    )
    from run_spark_model_baseline import canonical_digest


class ValidationError(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise ValidationError(message)


def validate(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    require(resolved.parent == (ROOT / "evidence/validation/feature-deployments").resolve(),
            "deployment evidence is unscoped")
    report = json.loads(resolved.read_text(encoding="utf-8"))
    run_id = report.get("runId")
    require(report.get("schemaVersion") == 1
            and report.get("runnerId") == "teamaibox.current-asr-global-diarization-product-deployment.v1"
            and isinstance(run_id, str) and RUN_ID.fullmatch(run_id) is not None
            and resolved.name == run_id + ".json"
            and report.get("status") == "passed" and report.get("failure") is None
            and report.get("componentReady") is True and report.get("productAccepted") is False,
            "deployment identity, result, or claim boundary drifted")
    payload = dict(report)
    claimed = payload.pop("evidenceDigest", None)
    require(claimed == canonical_digest(payload), "deployment evidence digest drifted")
    sources = {item.get("path"): item.get("sha256") for item in report.get("sources", [])
               if isinstance(item, Mapping)}
    require(set(sources) == set(SOURCES), "deployment source matrix drifted")
    for relative in SOURCES:
        require(sources[relative] == digest(ROOT / relative), "deployment source drifted: " + relative)
    for key, relative, parent_run_id, runner_id in PARENTS:
        _, binding = parent(relative, parent_run_id, runner_id)
        require(report.get("parents", {}).get(key) == binding, "immutable parent binding drifted: " + key)
    tests = source_tests()
    require(tests == report.get("sourceTests") and tests.get("nodeTests", 0) >= 54,
            "deployment source tests are incomplete")

    images = report.get("images", {})
    runtime = report.get("runtime", {})
    live = {
        "platform": inspect(PLATFORM),
        "asrPlugin": inspect(ASR_PLUGIN),
        "postgres": inspect(POSTGRES),
        "asrWorker": inspect(ASR_WORKER),
        "diarizationWorker": inspect(DIARIZATION_WORKER),
    }
    for key, value in live.items():
        require(value.get("State", {}).get("Running") is True
                and value.get("State", {}).get("Health", {}).get("Status") == "healthy",
                key + " is not healthy")
        require(value.get("Image") == images.get(key, {}).get("imageId"), key + " image drifted")
        require(value.get("Id") == runtime.get(key, {}).get("containerId"), key + " container drifted")
    diarization = live["diarizationWorker"]
    host = diarization.get("HostConfig", {})
    require(diarization.get("Config", {}).get("User") == "65532:65532"
            and host.get("ReadonlyRootfs") is True and host.get("CapDrop") == ["ALL"]
            and "no-new-privileges:true" in (host.get("SecurityOpt") or [])
            and not host.get("PortBindings") and host.get("Memory") == 8 * 1024 ** 3
            and host.get("NanoCpus") == 6_000_000_000,
            "diarization Worker isolation drifted")
    cold = json.loads(command(("sudo", "docker", "exec", PLATFORM, "node", "-e",
        "fetch('http://speaker-diarization-worker:8080/ready').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))"),
        "probe diarization residency", 30))
    require(cold.get("accepting") is True and cold.get("loaded") is False,
            "diarization model is resident outside demand")

    migration = report.get("migration", {})
    require(migration == {"version": MIGRATION_VERSION, "sha256": MIGRATION_SHA256,
                           "columns": 4, "postgresImageId": live["postgres"]["Image"], "replaySafe": True},
            "migration evidence drifted")
    database = command(("sudo", "docker", "exec", POSTGRES, "psql", "-U", "teamaibox", "-d", "teamaibox", "-Atc",
        f"SELECT (SELECT sha256 FROM public.teamaibox_schema_migrations WHERE version={MIGRATION_VERSION})||'|'||"
        "(SELECT count(*) FROM information_schema.columns WHERE table_schema='compute' AND table_name='asr_shard_plans' AND column_name IN ('profile_options','diarization_artifact_id','diarization_sha256','diarization_completed_at'))"),
        "verify migration", 30).strip()
    require(database == MIGRATION_SHA256 + "|4", "live migration drifted")
    profile = report.get("profile", {})
    require(profile.get("profileKey") == PROFILE_KEY and profile.get("certificationState") == "experimental"
            and profile.get("diarizationProfileKey") == DIARIZATION_PROFILE_KEY
            and profile.get("diarizationProfileFingerprint") == DIARIZATION_PROFILE_DIGEST
            and profile.get("maximumSpeakerCount") == 4 and profile.get("wavOnly") is True,
            "composite profile evidence drifted")
    profile_row = command(("sudo", "docker", "exec", POSTGRES, "psql", "-U", "teamaibox", "-d", "teamaibox", "-Atc",
        "SELECT profile.profile_key||'|'||encode(registration.profile_fingerprint,'hex')||'|'||profile.certification_state||'|'||(registration.profile_document#>>'{extensions,speaker_attribution,profile_fingerprint}')||'|'||profile.lifecycle_evidence_refs::text FROM compute.model_profiles profile JOIN compute.model_profile_registrations registration ON registration.profile_id=profile.id WHERE profile.id='" + profile["profileId"] + "'"),
        "verify composite profile", 30).strip().split("|")
    require(profile_row[:4] == [PROFILE_KEY, profile["profileFingerprint"][7:], "experimental",
                                DIARIZATION_PROFILE_DIGEST]
            and run_id in profile_row[4], "live composite profile drifted")
    selected = command(("sudo", "docker", "exec", POSTGRES, "psql", "-U", "teamaibox", "-d", "teamaibox", "-Atc",
        "SELECT evidence->>'profileId' FROM compute.node_capabilities binding JOIN compute.nodes node ON node.id=binding.node_id JOIN compute.capabilities capability ON capability.id=binding.capability_id WHERE node.node_key='spark-local' AND capability.capability_key='asr'"),
        "verify selected route", 30).strip()
    require(selected == profile["profileId"], "selected composite profile drifted")
    pins = command(("sudo", "grep", "-E",
        "^TEAMAIBOX_(CATALOG_PLATFORM_API_IMAGE|CATALOG_ASR_IMAGE|CATALOG_POSTGRES_IMAGE|SPEAKER_DIARIZATION_IMAGE|ASR_SHARD_PROFILE_ID|ASR_SHARD_PROFILE_KEY|ASR_SHARD_PROFILE_FINGERPRINT|ASR_SHARD_SPEAKER_INFORMATION_ENABLED|ASR_SHARD_DIARIZATION_WORKER_ORIGIN|ASR_SHARD_DIARIZATION_PROFILE_KEY|ASR_SHARD_DIARIZATION_PROFILE_FINGERPRINT|ASR_SHARD_DIARIZATION_ENGINE_IMAGE_DIGEST)=",
        RUNTIME), "read runtime pins", 30)
    expected = (
        "TEAMAIBOX_CATALOG_PLATFORM_API_IMAGE=" + live["platform"]["Image"],
        "TEAMAIBOX_CATALOG_ASR_IMAGE=" + live["asrPlugin"]["Image"],
        "TEAMAIBOX_CATALOG_POSTGRES_IMAGE=" + live["postgres"]["Image"],
        "TEAMAIBOX_SPEAKER_DIARIZATION_IMAGE=" + live["diarizationWorker"]["Image"],
        "TEAMAIBOX_ASR_SHARD_PROFILE_ID=" + profile["profileId"],
        "TEAMAIBOX_ASR_SHARD_PROFILE_KEY=" + PROFILE_KEY,
        "TEAMAIBOX_ASR_SHARD_PROFILE_FINGERPRINT=" + profile["profileFingerprint"],
        "TEAMAIBOX_ASR_SHARD_SPEAKER_INFORMATION_ENABLED=true",
        "TEAMAIBOX_ASR_SHARD_DIARIZATION_WORKER_ORIGIN=http://speaker-diarization-worker:8080",
        "TEAMAIBOX_ASR_SHARD_DIARIZATION_PROFILE_KEY=" + DIARIZATION_PROFILE_KEY,
        "TEAMAIBOX_ASR_SHARD_DIARIZATION_PROFILE_FINGERPRINT=" + DIARIZATION_PROFILE_DIGEST,
        "TEAMAIBOX_ASR_SHARD_DIARIZATION_ENGINE_IMAGE_DIGEST=" + live["diarizationWorker"]["Image"],
    )
    for value in expected:
        require(value in pins, "persistent runtime pin drifted")
    platform_environment = {
        item.split("=", 1)[0]: item.split("=", 1)[1]
        for item in live["platform"].get("Config", {}).get("Env", [])
        if "=" in item
    }
    expected_platform_environment = {
        "ASR_SHARDING_ENABLED": "true",
        "ASR_SHARD_PROFILE_ID": profile["profileId"],
        "ASR_SHARD_PROFILE_KEY": PROFILE_KEY,
        "ASR_SHARD_PROFILE_FINGERPRINT": profile["profileFingerprint"],
        "ASR_SHARD_ENGINE_IMAGE_DIGEST": live["asrWorker"]["Image"],
        "ASR_SHARD_NODE_KEY": "spark-local",
        "ASR_SHARD_SPEAKER_INFORMATION_ENABLED": "true",
        "ASR_SHARD_DIARIZATION_WORKER_ORIGIN": "http://speaker-diarization-worker:8080",
        "ASR_SHARD_DIARIZATION_PROFILE_KEY": DIARIZATION_PROFILE_KEY,
        "ASR_SHARD_DIARIZATION_PROFILE_FINGERPRINT": DIARIZATION_PROFILE_DIGEST,
        "ASR_SHARD_DIARIZATION_ENGINE_IMAGE_DIGEST": live["diarizationWorker"]["Image"],
        "ASR_SHARD_DIARIZATION_MAX_SPEAKERS": "4",
    }
    for key, value in expected_platform_environment.items():
        require(platform_environment.get(key) == value, "live Platform environment drifted: " + key)
    require(report.get("blockers") == ["release-candidate ASR/diarization quality and soak", "physical 10GbE ASR",
                                        "independent administrator/member acceptance"],
            "deployment blockers drifted")
    require(report.get("cleanup") == {"runRootRemoved": True, "baseTagsRemoved": True,
                                       "candidatePlatformAbsent": True, "previousPlatformAbsent": True},
            "deployment cleanup drifted")
    return {"valid": True, "runId": run_id, "evidenceDigest": claimed,
            "profileKey": PROFILE_KEY, "profileFingerprint": profile["profileFingerprint"],
            "modelResidency": "unloaded", "productAccepted": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    print(json.dumps(validate(parser.parse_args().evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationError, OSError, ValueError, json.JSONDecodeError) as error:
        print("Current ASR global-diarization deployment evidence invalid: " + str(error))
        raise SystemExit(1)
