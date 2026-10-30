#!/usr/bin/env python3
"""Strictly validate immutable Drawing model portfolio qualification evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

try:
    from .run_spark_model_baseline import canonical_digest
    from .run_drawing_model_portfolio_qualification import ROOT, SOURCES
    from .validate_drawing_model_portfolio import PORTFOLIO, validate
except ImportError:
    from run_spark_model_baseline import canonical_digest
    from run_drawing_model_portfolio_qualification import ROOT, SOURCES
    from validate_drawing_model_portfolio import PORTFOLIO, validate


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def digest(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def validate_evidence(path: Path) -> dict[str, object]:
    require(path.is_file() and path.is_relative_to(ROOT), "Drawing portfolio evidence is missing or unscoped")
    value = json.loads(path.read_text(encoding="utf-8"))
    claimed = value.get("evidenceDigest")
    require(claimed == canonical_digest({key: item for key, item in value.items() if key != "evidenceDigest"}),
            "Drawing portfolio evidence digest drifted")
    require(value.get("runnerId") == "teamaibox.drawing-model-portfolio-qualification.v1" and
            value.get("status") == "passed" and value.get("failure") is None,
            "Drawing portfolio qualification did not pass")
    source_map = {item["path"]: item["sha256"] for item in value.get("sources", [])}
    require(set(source_map) == {item.relative_to(ROOT).as_posix() for item in SOURCES},
            "Drawing portfolio qualification sources are incomplete")
    for source in SOURCES:
        require(source_map[source.relative_to(ROOT).as_posix()] == digest(source.read_bytes()),
                "Drawing portfolio qualification source drifted: " + source.name)
    portfolio = json.loads(PORTFOLIO.read_text(encoding="utf-8"))
    summary = validate(portfolio)
    require(value["portfolio"] == {"portfolioId": "teamaibox.drawing.portfolio.v1",
            "sha256": digest(PORTFOLIO.read_bytes()), "summary": summary},
            "Drawing portfolio binding drifted")
    upstream = value["upstream"]
    require(upstream["allPassed"] is True and len(upstream["localCandidates"]) == 11 and
            len(upstream["externalCandidates"]) == 2 and
            all(item["passed"] is True for item in upstream["localCandidates"] + upstream["externalCandidates"]),
            "Drawing portfolio upstream checks are incomplete")
    require(value["tests"]["exitCode"] == 0 and value["tests"]["outputRetained"] is False,
            "Drawing portfolio source tests did not pass")
    boundary = value["claimBoundary"]
    require(boundary == {"task7_18Complete": True, "modelsDownloaded": False,
            "modelsDeployed": False, "modelsCertified": False, "automaticRoutingEnabled": False,
            "task7_19Complete": False, "task7_20Complete": False, "task7_21Complete": False,
            "task7_22Complete": False, "task8_2Complete": False, "task18_5Complete": False},
            "Drawing portfolio claim boundary drifted")
    require(value["privacy"] == {"credentialsUsed": False, "credentialsRetained": False,
            "userContentUsed": False, "commandOutputRetained": False},
            "Drawing portfolio privacy boundary drifted")
    return {"valid": True, "runId": value["runId"], "evidenceDigest": claimed,
            "localCandidates": 11, "externalCandidates": 2, "aliases": 9}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(validate_evidence(args.evidence.resolve()), separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, json.JSONDecodeError, ValueError, KeyError) as error:
        raise SystemExit(f"Drawing portfolio evidence validation failed: {error}")
