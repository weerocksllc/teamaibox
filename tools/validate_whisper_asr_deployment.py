#!/usr/bin/env python3
"""Validate the immutable Whisper Large-v3 Spark deployment declaration."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / "deploy/compute/asr-whisper-large-v3-spark.v1.json"
RUNTIME_PROFILE = ROOT / "deploy/compute/asr-whisper-large-v3-runtime.v2.json"
CANDIDATES = ROOT / "models/candidate-matrix.v1.json"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def validate() -> dict[str, Any]:
    profile = json.loads(PROFILE.read_text(encoding="utf-8"))
    candidates = json.loads(CANDIDATES.read_text(encoding="utf-8"))
    matches = [item for item in candidates["candidates"] if item["candidateId"] == profile.get("candidateId")]
    require(len(matches) == 1 and matches[0]["artifactDecision"]["status"] == "allowed", "ASR candidate is not artifact eligible")
    candidate = matches[0]
    require(profile.get("schemaVersion") == 1 and profile.get("profileKey") == "asr.whisper-large-v3.fp16.spark.v1", "ASR profile identity drifted")
    source = profile.get("source", {})
    require(source.get("repository") == candidate["source"]["repository"] and source.get("release") == candidate["source"]["revision"], "ASR source lineage drifted")
    require(len(source.get("commit", "")) == 40 and source.get("archiveUrl") == "https://api.github.com/repos/openai/whisper/tarball/31243bad24cc746f07d4c8bfdd2d974872cb1803", "ASR engine source is not immutable")
    require(source.get("archiveSha256") == "sha256:22dada419206cb2f003f7c7bd75fb780694c204b6909bef5c693e29fefee33f1" and source.get("archiveSizeBytes") == 7262941, "ASR engine source artifact integrity drifted")
    artifact = profile.get("modelArtifact", {})
    require(artifact.get("sha256") == "sha256:e5b1a55b89c1367dacf97e3e19bfd829a01529dbfdeefa8caeb59b3f1b81dadb", "ASR checkpoint digest drifted")
    require(artifact.get("sizeBytes") == 3087371615 and artifact.get("sha256")[7:] in artifact.get("url", ""), "ASR checkpoint size or URL drifted")
    runtime = profile.get("runtime", {})
    require(runtime.get("platform") == "linux/arm64/v8" and "@sha256:" in runtime.get("baseImage", ""), "ASR runtime is not ARM64 digest pinned")
    require(runtime.get("precision") == "fp16" and runtime.get("engine") == "openai-whisper-pytorch", "ASR engine or precision drifted")
    require(runtime.get("audioDecoder") == "soundfile-0.13.1+scipy-resample-poly", "ASR decoder boundary drifted")
    dependencies = runtime.get("dependencyArtifacts", [])
    require(dependencies == [{
        "name": "more-itertools",
        "version": "10.8.0",
        "url": "https://files.pythonhosted.org/packages/a4/8e/469e5a4a2f5855992e425f3cb33804cc07bf18d48f2db061aec61ce50270/more_itertools-10.8.0-py3-none-any.whl",
        "sha256": "sha256:52d4362373dcf7c52546bc4af9a86ee7c4579df9a8dc268be0a2f949d376cc9b",
        "sizeBytes": 69667,
        "buildContextPath": "dependencies/more_itertools-10.8.0-py3-none-any.whl",
    }], "ASR build dependency is not immutable")
    for field in ("workerSource", "dockerfile"):
        require((ROOT / runtime[field]).is_file(), f"ASR {field} is missing")
    api = profile.get("api", {})
    require(api.get("contracts") == ["openai.audio-transcriptions@v1"] and api.get("maximumConcurrentRequests") == 1, "ASR API contract drifted")
    require(set(api.get("responseFormats", [])) == {"json", "verbose_json", "text", "srt", "vtt"} and set(api.get("timestampGranularities", [])) == {"segment", "word"}, "ASR result formats are incomplete")
    require(set(api.get("acceptedAudioFormats", [])) == {"wav", "flac", "ogg", "mp3", "aiff", "aif", "au", "caf", "w64"}, "ASR decoder formats drifted")
    scheduling = profile.get("scheduling", {})
    require(scheduling.get("resourceMode") == "shared" and scheduling.get("memoryLimitBytes", 0) >= 8 * 1024**3 and scheduling.get("coreServiceReserveBytes") == 12 * 1024**3, "ASR scheduling boundary drifted")
    security = profile.get("security", {})
    require(security == {"runAs": "1000:1000", "readOnlyRootFilesystem": True, "capabilitiesDropped": ["ALL"], "noNewPrivileges": True, "modelArtifactReadOnly": True, "internetAtRuntime": False, "publishedPorts": []}, "ASR security boundary drifted")
    worker_source = (ROOT / runtime["workerSource"]).read_text(encoding="utf-8")
    require("/v1/audio/transcriptions" in worker_source and "digest_file(checkpoint)" in worker_source and "access_log=False" in worker_source, "ASR worker lacks API, integrity, or content-safe logging boundary")
    require("sf.read" in worker_source and "resample_poly" in worker_source and "model.transcribe(decode_audio(path)" in worker_source, "ASR worker does not use the bounded in-process decoder")
    dockerfile = (ROOT / runtime["dockerfile"]).read_text(encoding="utf-8")
    require("apt " not in dockerfile and "apt-get" not in dockerfile and "--no-index --no-deps" in dockerfile, "ASR image performs an unpinned network install")
    require(dependencies[0]["buildContextPath"] in dockerfile, "ASR immutable dependency is not installed from the build context")
    require("TRITON_CACHE_DIR=/var/cache/triton" in dockerfile, "ASR image does not pin its timestamp-kernel cache")
    runtime_profile = json.loads(RUNTIME_PROFILE.read_text(encoding="utf-8"))
    # These declarations are not deployment-specific evidence. A publisher must
    # resolve its installation-owned bind address explicitly, never inherit a
    # historical appliance address from source control.
    for version in (1, 2):
        declaration = json.loads((ROOT / f"deploy/compute/asr-whisper-large-v3-runtime.v{version}.json").read_text(encoding="utf-8"))
        require(declaration.get("publishedEndpoint") == {
            "hostFromEnvironment": "TEAMAIBOX_ASR_PUBLISH_HOST", "port": 18083, "containerPort": 8080,
        }, "ASR endpoint must use the installation's explicit host configuration")
    require(runtime_profile.get("profileKey") == "asr.whisper-large-v3.fp16.spark-worker02.audio.runtime.v2", "ASR retained runtime identity drifted")
    require(runtime_profile.get("runAs") == "1000:1000" and runtime_profile.get("environment") == {"TRITON_CACHE_DIR": "/var/cache/triton"}, "ASR retained runtime user or cache environment drifted")
    timestamp_tmpfs = [item for item in runtime_profile.get("temporaryFilesystems", []) if item.get("path") == "/var/cache/triton"]
    require(len(timestamp_tmpfs) == 1 and timestamp_tmpfs[0].get("sizeBytes") == 268435456, "ASR timestamp tmpfs is missing or unbounded")
    require(set(timestamp_tmpfs[0].get("options", [])) == {"rw", "exec", "nosuid", "nodev", "uid=1000", "gid=1000", "mode=0700"}, "ASR timestamp tmpfs lacks executable non-root ownership")
    require("validate_timestamp_runtime" in worker_source and "median_filter_cuda" in worker_source and "dtw_cuda" in worker_source, "ASR readiness does not exercise both CUDA timestamp kernels")
    return {"valid": True, "profileKey": profile["profileKey"], "profileDigest": digest(profile), "candidateId": profile["candidateId"]}


if __name__ == "__main__":
    print(json.dumps(validate(), sort_keys=True, separators=(",", ":")))
