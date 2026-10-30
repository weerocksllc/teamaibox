#!/usr/bin/env python3
"""Bind the exact Z-Image-Turbo candidate, runtime and quality qualification."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from typing import Any, Mapping

try:
    from .run_spark_model_baseline import canonical_digest, utc_now
except ImportError:
    from run_spark_model_baseline import canonical_digest, utc_now


ROOT = Path(__file__).resolve().parents[1]
RUN_ID = re.compile(r"^z-image-turbo-qualification-[0-9]{8}-a[1-9][0-9]*$")
PROFILE_KEY = "drawing.z-image-turbo.bf16.spark23.candidate.v1"
PARENTS = {
    "candidate": ("evidence/validation/model-candidates/z-image-turbo-candidate-20260901-a1.json",
                  "tools/validate_z_image_turbo_candidate.py", 4200),
    "runtimeSmoke": ("evidence/validation/model-smoke/z-image-turbo-runtime-smoke-20260901-a2.json",
                     "tools/validate_z_image_turbo_runtime_smoke.py", 4200),
    "quality": ("evidence/validation/model-quality/z-image-turbo-quality-20260901-a2.json",
                "tools/validate_z_image_turbo_quality.py", 7200),
}
SOURCES = ("tools/run_z_image_turbo_qualification.py",
           "tools/validate_z_image_turbo_qualification.py",
           "tests/test_z_image_turbo_qualification.py")


class QualificationError(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise QualificationError(message)


def sha(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def write(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def validate_parent(key: str) -> tuple[dict[str, Any], dict[str, Any]]:
    relative, validator, timeout = PARENTS[key]
    path = ROOT / relative
    require(path.is_file(), "Z-Image qualification parent is missing: " + key)
    checked = subprocess.run(["python3", str(ROOT / validator), "--evidence", str(path)], cwd=ROOT,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, check=False)
    require(checked.returncode == 0, "Z-Image qualification parent no longer validates: " + key)
    value = json.loads(path.read_text(encoding="utf-8"))
    return value, {"path": relative, "fileSha256": sha(path.read_bytes()),
                   "evidenceDigest": value["evidenceDigest"], "runId": value["runId"],
                   "validationOutputSha256": sha(checked.stdout), "validationOutputRetained": False}


def run(run_id: str, output: Path) -> dict[str, Any]:
    require(RUN_ID.fullmatch(run_id) is not None and not output.exists(),
            "unsafe or occupied Z-Image qualification identity")
    for relative in SOURCES:
        require((ROOT / relative).is_file(), "qualification source is missing: " + relative)
    report: dict[str, Any] = {"schemaVersion": 1,
        "runnerId": "teamaibox.z-image-turbo-qualification.v1", "runId": run_id,
        "status": "failed", "startedAt": utc_now(), "completedAt": None,
        "profileKey": PROFILE_KEY, "parents": {}, "coverage": None, "measurements": None,
        "decision": None,
        "sources": [{"path": relative, "sha256": sha((ROOT / relative).read_bytes())}
                    for relative in SOURCES],
        "privacy": {"credentialsRetained": False, "promptsRetained": False,
                    "imagesRetained": False, "userContentRetained": False},
        "claimBoundary": {"task7_20Complete": False, "certification": "validating",
                           "certified": False, "productRouted": False,
                           "productAccepted": False}, "failure": None}
    try:
        values: dict[str, Any] = {}
        parents: dict[str, Any] = {}
        for key in PARENTS:
            values[key], parents[key] = validate_parent(key)
        report["parents"] = parents
        runtime = values["runtimeSmoke"]
        quality = values["quality"]
        cycles = runtime["cycles"]
        report["coverage"] = {"exactRevisionAndManifest": True, "arm64Runtime": True,
            "generation": True, "editingDisabled": True, "multiReferenceDisabled": True,
            "englishText": True, "chineseText": True, "portrait": True, "product": True,
            "diversity": True, "commonQualityCorpus": True, "coldWarmLatency": True,
            "peakUnifiedMemory": True, "cancellation": True, "unloadReload": True,
            "sameSeedReproducibility": True, "security": True, "coexistence": True}
        report["measurements"] = {"artifactBytes": values["candidate"]["candidate"]["totalBytes"],
            "artifactDigest": values["candidate"]["candidate"]["artifactDigest"],
            "cycle1LoadSeconds": cycles[0]["loadSeconds"], "cycle2LoadSeconds": cycles[1]["loadSeconds"],
            "cycle1DurationSeconds": cycles[0]["durationSeconds"],
            "cycle2DurationSeconds": cycles[1]["durationSeconds"],
            "peakCudaAllocatedBytes": max(item["resources"]["peakCudaAllocatedBytes"] for item in cycles),
            "peakCudaReservedBytes": max(item["resources"]["peakCudaReservedBytes"] for item in cycles),
            "qualityCaseCount": quality["quality"]["caseCount"],
            "qualityAggregate": quality["quality"]["aggregate"],
            "qualityReferenceDeltas": quality["comparison"]["clipDelta"]}
        report["decision"] = {"selectedForPortfolio": True, "role": "generation-only validating candidate",
            "qualityWithinDevelopmentBudget": quality["comparison"]["qualityWithinDevelopmentBudget"],
            "automaticEligible": False, "defaultIntent": None,
            "generationOnlyBoundary": {"generation": True, "editing": False, "multiReference": False},
            "requiresProductProfileAndRouteBeforeUserAvailability": True}
        require(report["measurements"]["qualityCaseCount"] == 50
                and report["decision"]["qualityWithinDevelopmentBudget"] is True,
                "Z-Image final qualification facts are incomplete")
        report["status"] = "passed"
        report["claimBoundary"] = {"task7_20Complete": True, "certification": "validating",
            "certified": False, "productRouted": False, "productAccepted": False}
    except Exception as error:
        report["failure"] = {"type": type(error).__name__, "message": str(error)[:1200]}
    report["completedAt"] = utc_now()
    report["evidenceDigest"] = canonical_digest(report)
    write(output, report)
    require(report["status"] == "passed", "Z-Image qualification failed; immutable evidence retained")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    output = ROOT / "evidence/validation/model-qualification" / f"{args.run_id}.json"
    value = run(args.run_id, output)
    print(json.dumps({"runId": args.run_id, "status": value["status"],
        "evidence": output.relative_to(ROOT).as_posix(), "evidenceDigest": value["evidenceDigest"],
        "task7_20Complete": True}, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (QualificationError, OSError, ValueError, KeyError, json.JSONDecodeError,
            subprocess.TimeoutExpired) as error:
        raise SystemExit("Z-Image qualification failed: " + str(error))
