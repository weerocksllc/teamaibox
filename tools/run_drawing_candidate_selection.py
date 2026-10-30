#!/usr/bin/env python3
"""Select bounded Drawing defaults from exact Spark candidate evidence."""

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
RUN_ID = re.compile(r"^drawing-candidate-selection-[0-9]{8}-a[1-9][0-9]*$")
PARENTS = {
    "senseNovaPreflight": (ROOT / "evidence/validation/model-candidates/sensenova-u1-5-arm64-preflight-20260901-a1.json",
        "tools/validate_sensenova_arm64_preflight.py", 300),
    "glmQualityRejected": (ROOT / "evidence/validation/model-quality/glm-image-quality-20260901-a3.json",
        None, 0),
    "longCatQuality": (ROOT / "evidence/validation/model-quality/longcat-image-quality-20260901-a1.json",
        "tools/validate_longcat_image_quality.py", 18000),
    "qwenQuality": (ROOT / "evidence/validation/model-quality/qwen-image-2512-lightning-quality-20260901-a1.json",
        "tools/validate_qwen_image_2512_lightning_quality.py", 18000),
}
SOURCES = (ROOT / "tools/run_drawing_candidate_selection.py",
    ROOT / "tools/validate_drawing_candidate_selection.py",
    ROOT / "tests/test_drawing_candidate_selection.py")
MEMORY_BUDGET = {"workerHardLimitGiB": 80, "coreServiceReserveGiB": 32,
    "transientMarginGiB": 16, "minimumAvailableAfterDrainGiB": 96}


class SelectionError(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise SelectionError(message)


def sha(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def write(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def load_parent(path: Path, validator: Any, timeout: int) -> tuple[dict[str, Any], dict[str, Any]]:
    require(path.is_file(), "selection parent missing: " + path.name)
    value = json.loads(path.read_text(encoding="utf-8"))
    if validator is not None:
        checked = subprocess.run(["python3", str(ROOT / validator), "--evidence", str(path)], cwd=ROOT,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, check=False)
        require(checked.returncode == 0, "selection parent no longer validates: " + path.name)
    else:
        recorded = value.pop("evidenceDigest", None)
        require(recorded == canonical_digest(value), "rejected GLM evidence digest drifted")
        value["evidenceDigest"] = recorded
        require(value.get("status") == "failed"
            and value["comparison"]["qualityWithinDevelopmentBudget"] is False
            and value["claimBoundary"]["commonQualityQualified"] is False,
            "GLM rejection facts drifted")
    parent = {"path": path.relative_to(ROOT).as_posix(), "fileSha256": sha(path.read_bytes()),
        "evidenceDigest": value["evidenceDigest"], "runId": value["runId"], "status": value["status"]}
    return value, parent


def metrics(value: dict[str, Any], *, generation_key: bool = False) -> dict[str, Any]:
    quality = value["quality"]["generation"] if generation_key else value["quality"]
    aggregate = quality["aggregate"]
    cases = quality["cases"]
    return {"caseCount": len(cases), "averageGenerationSeconds": round(
        sum(float(item["durationSeconds"]) for item in cases) / len(cases), 8),
        "overallClipSimilarity": aggregate["overall"]["clipSimilarity"],
        "overallAestheticScore": aggregate["overall"]["aestheticScore"],
        "overallSevereVisualDefectRate": aggregate["overall"]["severeVisualDefectRate"],
        "textClipSimilarity": aggregate["text-rendering"]["clipSimilarity"],
        "zhClipSimilarity": aggregate["zh-prompts"]["clipSimilarity"],
        "peakCudaAllocatedBytes": value["quality"]["peakCudaAllocatedBytes"]}


def build(run_id: str) -> dict[str, Any]:
    require(RUN_ID.fullmatch(run_id) is not None, "unsafe Drawing selection identity")
    for source in SOURCES:
        require(source.is_file(), "selection source missing: " + source.name)
    values: dict[str, dict[str, Any]] = {}
    parents: dict[str, dict[str, Any]] = {}
    for key, (path, validator, timeout) in PARENTS.items():
        values[key], parents[key] = load_parent(path, validator, timeout)
    longcat = values["longCatQuality"]
    qwen = values["qwenQuality"]
    glm = values["glmQualityRejected"]
    sense = values["senseNovaPreflight"]
    longcat_edit = longcat["quality"]["editing"]["aggregate"]["overall"]
    require(longcat["comparison"]["qualityWithinDevelopmentBudget"] is True
        and qwen["comparison"]["qualityWithinDevelopmentBudget"] is True,
        "accepted local candidate quality drifted")
    require(longcat_edit["severeVisualDefectRate"] == 1.0,
        "LongCat edit caution boundary drifted")
    require(sense["runtime"]["sensenova15"] is False
        and sense["claimBoundary"]["automaticEligible"] is False,
        "SenseNova feasibility disposition drifted")
    longcat_metrics = metrics(longcat, generation_key=True)
    qwen_metrics = metrics(qwen)
    require(qwen_metrics["averageGenerationSeconds"] < longcat_metrics["averageGenerationSeconds"],
        "Qwen fast-default evidence drifted")
    require(longcat_metrics["overallClipSimilarity"] > qwen_metrics["overallClipSimilarity"]
        and longcat_metrics["overallSevereVisualDefectRate"] < qwen_metrics["overallSevereVisualDefectRate"],
        "LongCat quality-default evidence drifted")
    return {"schemaVersion": 1, "runnerId": "teamaibox.drawing-candidate-selection.v1",
        "runId": run_id, "status": "passed", "startedAt": utc_now(), "completedAt": utc_now(),
        "parents": parents, "memoryBudget": MEMORY_BUDGET,
        "candidates": {
            "sensenova-u1.5": {"disposition": "deferred", "automaticEligible": False,
                "reason": "current pinned ARM64 runtime has no SenseNova U1.5 implementation; no model was downloaded"},
            "glm-image": {"disposition": "rejected", "automaticEligible": False,
                "qualityWithinDevelopmentBudget": False,
                "overallClipDelta": glm["comparison"]["clipDelta"]["overall"]},
            "longcat-image": {"disposition": "selected", "automaticEligible": True,
                "profile": "drawing.longcat-image.bf16.spark-worker02.v1", "metrics": longcat_metrics},
            "longcat-image-edit-turbo": {"disposition": "manual-only", "automaticEligible": False,
                "profile": "drawing.longcat-image-edit-turbo.bf16.spark-worker02.v1",
                "reason": "all ten edit samples triggered the current severe-defect heuristic; retain for explicit evaluation only",
                "editSevereVisualDefectRate": longcat_edit["severeVisualDefectRate"]},
            "qwen-image-2512-lightning": {"disposition": "selected", "automaticEligible": True,
                "profile": "drawing.qwen-image-2512-lightning.bf16.spark-worker02.v1", "metrics": qwen_metrics}},
        "intentDefaults": {
            "drawing.default": "drawing.qwen-image-2512-lightning.bf16.spark-worker02.v1",
            "drawing.fast": "drawing.qwen-image-2512-lightning.bf16.spark-worker02.v1",
            "drawing.text": "drawing.qwen-image-2512-lightning.bf16.spark-worker02.v1",
            "drawing.quality": "drawing.longcat-image.bf16.spark-worker02.v1",
            "drawing.zh": "drawing.longcat-image.bf16.spark-worker02.v1",
            "drawing.edit": None},
        "fallbacks": {"drawing.edit": {"policy": "external-overflow-only",
            "reason": "no tested local edit candidate is automatically eligible"}},
        "selectedLocalProfiles": ["drawing.longcat-image.bf16.spark-worker02.v1",
            "drawing.qwen-image-2512-lightning.bf16.spark-worker02.v1"],
        "sources": [{"path": source.relative_to(ROOT).as_posix(), "sha256": sha(source.read_bytes())}
            for source in SOURCES],
        "claimBoundary": {"candidateComparisonComplete": True, "intentDefaultsSelected": True,
            "task7_21Complete": True, "profilesDeployed": False, "productRouted": False,
            "task18_5Complete": False}, "failure": None}


def run(run_id: str, output: Path) -> dict[str, Any]:
    require(not output.exists(), "occupied Drawing selection identity")
    value = build(run_id)
    value["evidenceDigest"] = canonical_digest(value)
    write(output, value)
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    run_id = parser.parse_args().run_id
    output = ROOT / "evidence/validation/model-candidates" / f"{run_id}.json"
    value = run(run_id, output)
    print(json.dumps({"runId": run_id, "status": value["status"],
        "evidence": output.relative_to(ROOT).as_posix(), "evidenceDigest": value["evidenceDigest"]},
        sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (SelectionError, OSError, ValueError, KeyError, json.JSONDecodeError,
            subprocess.TimeoutExpired) as error:
        raise SystemExit("Drawing candidate selection failed: " + str(error))
