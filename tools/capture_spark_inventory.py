#!/usr/bin/env python3
"""Capture the sanitized read-only inventory from an allowlisted Spark target."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess
from typing import Any, Mapping, Sequence

try:
    from .spark_inventory import assert_sanitized
    from .spark_validation import ALLOWED_SPARK_TARGETS
except ImportError:
    from spark_inventory import assert_sanitized
    from spark_validation import ALLOWED_SPARK_TARGETS


ROOT = Path(__file__).resolve().parents[1]
COLLECTOR = ROOT / "tools/spark_inventory.py"
EVIDENCE_ROOT = ROOT / "evidence/hardware"
TARGETS = {logical: ssh for ssh, logical in ALLOWED_SPARK_TARGETS.items()}


class RemoteInventoryError(RuntimeError):
    pass


def default_evidence_path(target: str, day: dt.date | None = None) -> Path:
    if target not in TARGETS:
        raise RemoteInventoryError("inventory target is not allowlisted")
    selected_day = day or dt.datetime.now(dt.timezone.utc).date()
    return EVIDENCE_ROOT / target / f"inventory-{selected_day.isoformat()}.json"


def validate_report(value: Any) -> Mapping[str, Any]:
    if not isinstance(value, dict) or value.get("schema_version") != "1.0":
        raise RemoteInventoryError("remote inventory schema is invalid")
    collector = value.get("collector")
    if not isinstance(collector, dict) or collector.get("read_only") is not True:
        raise RemoteInventoryError("remote inventory did not attest read-only collection")
    try:
        assert_sanitized(value)
    except ValueError as error:
        raise RemoteInventoryError("remote inventory failed sanitization") from error
    return value


def capture(target: str, evidence_path: Path | None = None) -> Path:
    ssh_target = TARGETS.get(target)
    if ssh_target is None:
        raise RemoteInventoryError("inventory target is not allowlisted")
    completed = subprocess.run(
        [
            "ssh",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=5",
            ssh_target,
            "python3", "-", "--pretty",
        ],
        input=COLLECTOR.read_text(encoding="utf-8"),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
        check=False,
    )
    if completed.returncode != 0:
        raise RemoteInventoryError("remote read-only inventory command failed")
    try:
        report = validate_report(json.loads(completed.stdout))
    except json.JSONDecodeError as error:
        raise RemoteInventoryError("remote inventory returned invalid JSON") from error

    output = (evidence_path or default_evidence_path(target)).resolve()
    evidence_root = EVIDENCE_ROOT.resolve()
    if output != evidence_root and evidence_root not in output.parents:
        raise RemoteInventoryError("inventory evidence path must remain under evidence/hardware")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(output)
    return output


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=tuple(sorted(TARGETS)), required=True)
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args(argv)
    try:
        output = capture(args.target, args.evidence)
    except (OSError, subprocess.TimeoutExpired, RemoteInventoryError) as error:
        parser.exit(2, f"inventory failed: {error}\n")
    print(output.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
