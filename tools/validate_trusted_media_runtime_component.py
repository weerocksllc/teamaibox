#!/usr/bin/env python3
"""Validate the blocked trusted-media release-set component contract.

Passing this validator proves only static/component readiness.  It cannot build
or deploy the receiver, approve legal/supply-chain gates, or complete task 22.3.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.trusted_media_service.runtime_orchestrator import TEMPLATE, validate_component_template


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=TEMPLATE)
    arguments = parser.parse_args()
    result = validate_component_template(arguments.manifest)
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
