#!/usr/bin/env python3
"""Strictly validate one exact ARM64 feature deployment without requiring cleanup."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Sequence

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.validate_feature_arm64_deployment_evidence import validate_deployment


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    args = parser.parse_args(argv)
    evidence = json.loads(args.evidence.resolve().read_text(encoding="utf-8"))
    plan = json.loads(args.plan.resolve().read_text(encoding="utf-8"))
    print(json.dumps(validate_deployment(evidence, plan), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
