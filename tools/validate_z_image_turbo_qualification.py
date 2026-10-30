#!/usr/bin/env python3
"""Strictly validate exact Z-Image-Turbo task 7.20 qualification."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess

try:
    from .run_spark_model_baseline import canonical_digest
    from .run_z_image_turbo_qualification import PARENTS, PROFILE_KEY, ROOT, RUN_ID, SOURCES, sha
except ImportError:
    from run_spark_model_baseline import canonical_digest
    from run_z_image_turbo_qualification import PARENTS, PROFILE_KEY, ROOT, RUN_ID, SOURCES, sha


def require(value: bool, message: str) -> None:
    if not value:
        raise ValueError(message)


def validate(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    recorded = value.pop("evidenceDigest", None)
    require(recorded == canonical_digest(value), "Z-Image qualification digest drifted")
    value["evidenceDigest"] = recorded
    require(value.get("runnerId") == "teamaibox.z-image-turbo-qualification.v1"
            and RUN_ID.fullmatch(str(value.get("runId", ""))) is not None
            and path.name == value["runId"] + ".json" and value.get("status") == "passed"
            and value.get("failure") is None and value.get("profileKey") == PROFILE_KEY,
            "Z-Image qualification identity drifted")
    require(set(value["parents"]) == set(PARENTS), "qualification parent set drifted")
    for key, (relative, validator, timeout) in PARENTS.items():
        parent_path = ROOT / relative
        parent_value = json.loads(parent_path.read_text(encoding="utf-8"))
        parent = value["parents"][key]
        checked = subprocess.run(["python3", str(ROOT / validator), "--evidence", str(parent_path)], cwd=ROOT,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 timeout=timeout, check=False)
        require(checked.returncode == 0 and parent["path"] == relative
                and parent["fileSha256"] == sha(parent_path.read_bytes())
                and parent["evidenceDigest"] == parent_value["evidenceDigest"]
                and parent["validationOutputSha256"] == sha(checked.stdout)
                and parent["validationOutputRetained"] is False,
                "qualification parent drifted: " + key)
    bindings = {item["path"]: item["sha256"] for item in value["sources"]}
    require(bindings == {relative: sha((ROOT / relative).read_bytes()) for relative in SOURCES},
            "qualification source bindings drifted")
    expected_coverage = {"exactRevisionAndManifest", "arm64Runtime", "generation", "editingDisabled",
        "multiReferenceDisabled", "englishText", "chineseText", "portrait", "product", "diversity",
        "commonQualityCorpus", "coldWarmLatency", "peakUnifiedMemory", "cancellation", "unloadReload",
        "sameSeedReproducibility", "security", "coexistence"}
    require(set(value["coverage"]) == expected_coverage and all(value["coverage"].values()),
            "qualification coverage drifted")
    measurements = value["measurements"]
    require(measurements["artifactBytes"] == 32848319217 and measurements["qualityCaseCount"] == 50
            and measurements["peakCudaAllocatedBytes"] > 0 and measurements["peakCudaReservedBytes"] > 0
            and measurements["cycle1LoadSeconds"] > 0 and measurements["cycle2LoadSeconds"] > 0,
            "qualification measurements drifted")
    require(value["decision"] == {"selectedForPortfolio": True,
            "role": "generation-only validating candidate", "qualityWithinDevelopmentBudget": True,
            "automaticEligible": False, "defaultIntent": None,
            "generationOnlyBoundary": {"generation": True, "editing": False, "multiReference": False},
            "requiresProductProfileAndRouteBeforeUserAvailability": True}, "qualification decision drifted")
    require(value["claimBoundary"] == {"task7_20Complete": True, "certification": "validating",
            "certified": False, "productRouted": False, "productAccepted": False},
            "qualification claim boundary drifted")
    tests = subprocess.run(["python3", "-m", "unittest", "tests.test_z_image_turbo_qualification"],
                           cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=60, check=False)
    require(tests.returncode == 0, "qualification source tests no longer pass")
    return {"valid": True, "runId": value["runId"], "evidenceDigest": recorded,
            "task7_20Complete": True, "certification": "validating"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True, type=Path)
    path = parser.parse_args().evidence.resolve()
    require(path.is_file() and path.is_relative_to(ROOT / "evidence/validation/model-qualification"),
            "Z-Image qualification evidence is unscoped")
    print(json.dumps(validate(path), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
        raise SystemExit("Z-Image qualification validation failed: " + str(error))
