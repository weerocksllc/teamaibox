#!/usr/bin/env python3
"""Idempotently finalize the one pinned formal Spark soak without overwriting evidence."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
from typing import Sequence

try:
    from .validate_model_soak_evidence import validate as validate_soak
except ImportError:
    from validate_model_soak_evidence import validate as validate_soak


ROOT = Path(__file__).resolve().parents[1]
RUN_ID = "soak-20260811-nvfp4-24h-a2"
PROFILE_KEY = "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1"
REPORT = ROOT / f"evidence/validation/models/{RUN_ID}.json"


class SoakFinalizationError(RuntimeError):
    pass


def existing_report() -> dict:
    result = validate_soak()
    reports = result.get("reports", [])
    if len(reports) != 1 or reports[0].get("runId") != RUN_ID or reports[0].get("profileKey") != PROFILE_KEY:
        raise SoakFinalizationError("existing formal soak evidence identity drifted")
    return {
        "status": "already-finalized",
        "runId": RUN_ID,
        "evidenceDigest": reports[0]["evidenceDigest"],
        "evidenceOverwritten": False,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--profile-key", required=True)
    args = parser.parse_args(argv)
    if args.run_id != RUN_ID or args.profile_key != PROFILE_KEY:
        raise SoakFinalizationError("formal soak finalization identity is not allowlisted")
    if REPORT.exists():
        print(json.dumps(existing_report(), sort_keys=True, separators=(",", ":")))
        return 0
    command = [
        sys.executable,
        "tools/run_spark_model_soak.py",
        "--profile-key", PROFILE_KEY,
        "--run-id", RUN_ID,
        "--resume",
    ]
    completed = subprocess.run(command, cwd=ROOT, check=False)
    if completed.returncode != 0:
        raise SoakFinalizationError("formal soak finalization failed")
    existing_report()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
