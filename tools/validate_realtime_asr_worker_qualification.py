#!/usr/bin/env python3
"""Strictly validate one exact realtime-ASR CPU worker qualification."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Sequence


ROOT = Path(__file__).resolve().parents[1]
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
IMAGE_ID = "sha256:372e3155874907186872b641ff8cf4552d6a7d34dc54322806dfdef7357b3b5a"


def require(value: bool, message: str) -> None:
    if not value:
        raise ValueError(message)


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def canonical(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def validate(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    claimed = value.get("evidenceDigest")
    payload = {key: item for key, item in value.items() if key != "evidenceDigest"}
    require(SHA256.fullmatch(str(claimed)) is not None and claimed == canonical(payload), "realtime ASR evidence digest drifted")
    require(value.get("schemaVersion") == 1 and value.get("outcome") == "passed"
        and value.get("target") == "dgx-spark-dev-01" and value.get("certificationClaimed") is True, "realtime ASR qualification did not pass")
    require(value.get("source") == {
        "runnerDigest": digest(ROOT / "tools/run_realtime_asr_worker_qualification.py"),
        "validatorDigest": digest(Path(__file__)),
        "workerSourceDigest": digest(ROOT / "services/realtime-asr-worker/server.py"),
        "dockerfileDigest": digest(ROOT / "deploy/images/realtime-asr-cpu-worker.Dockerfile"),
    }, "realtime ASR source lineage drifted")
    runtime = value.get("runtime", {})
    require(runtime.get("imageId") == IMAGE_ID and runtime.get("architecture") == "arm64"
        and runtime.get("running") is True and runtime.get("healthy") is True, "realtime ASR image or health drifted")
    require(runtime.get("user") == "10001:10001" and runtime.get("readOnlyRootFilesystem") is True
        and runtime.get("capabilitiesDropped") == ["ALL"] and runtime.get("noNewPrivileges") is True
        and runtime.get("gpuRequested") is False, "realtime ASR isolation drifted")
    require(runtime.get("memoryLimitBytes") == 4294967296 and runtime.get("nanoCpus") == 8000000000
        and runtime.get("pidsLimit") == 256, "realtime ASR resource limits drifted")
    require(runtime.get("publishedPorts") == {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18084"}]}, "realtime ASR network boundary drifted")
    manifest = value.get("model", {}).get("manifest", {})
    require(value.get("model", {}).get("manifestDigest") == canonical(manifest)
        and manifest.get("repository") == "Systran/faster-whisper-small"
        and manifest.get("revision") == "536b0662742c02347bc0e980a01041f333bce120"
        and len(manifest.get("files", [])) == 4, "realtime ASR model manifest drifted")
    for item in manifest["files"]:
        require(set(item) == {"path", "sizeBytes", "sha256"} and item["sizeBytes"] > 0
            and re.fullmatch(r"[0-9a-f]{64}", item["sha256"]), "realtime ASR model file evidence is invalid")
    journeys = value.get("journeys", {})
    require(set(journeys) == {"shortEnglish", "chinese", "longEnglish", "shortAfterRestart"}, "realtime ASR journey set drifted")
    for key, journey in journeys.items():
        require(journey.get("passed") is True and journey.get("timestampsMonotonic") is True
            and journey.get("segmentCount", 0) > 0 and journey.get("audioOrTranscriptContentRetained") is False
            and SHA256.fullmatch(str(journey.get("inputDigest"))) and SHA256.fullmatch(str(journey.get("resultDigest"))), f"realtime ASR {key} failed")
    require(journeys["shortEnglish"]["quality"].get("tokenRecall") == 1
        and journeys["longEnglish"]["quality"].get("tokenRecall") == 1
        and journeys["shortAfterRestart"]["quality"].get("tokenRecall") == 1, "realtime ASR English quality drifted")
    require(journeys["chinese"]["quality"].get("characterErrorRate", 1) <= 0.15, "realtime ASR Chinese quality drifted")
    require(journeys["longEnglish"].get("durationSeconds", 0) >= 60, "realtime ASR long journey is too short")
    require(value.get("logConfidentiality", {}).get("passed") is True
        and value["logConfidentiality"].get("rawLogsRetained") is False, "realtime ASR log confidentiality failed")
    require(value.get("coexistence") == {"retainedApplicationReadyStatus": 200, "passed": True}, "retained application regressed")
    require(value.get("claimBoundary") == {
        "capability": "realtime-asr-chunks", "maximumChunkBytes": 8388608,
        "maximumConcurrentRequests": 1, "physicalTenGigabitQualified": False,
        "speakerDiarization": False, "videoContainerInput": False,
    }, "realtime ASR claim boundary was weakened")
    return {"valid": True, "runId": value["runId"], "evidenceDigest": claimed, "certificationClaimed": True}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence.resolve()), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
