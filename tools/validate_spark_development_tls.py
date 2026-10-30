#!/usr/bin/env python3
"""Strictly validate persistent Spark development TLS evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tools" / "ensure_spark_development_tls.py"
TOP_KEYS = {"schemaVersion", "runnerId", "runId", "status", "startedAt", "completedAt", "target", "volume",
            "created", "certificate", "checks", "source", "credentialsRetained", "commandOutputRetained", "failure",
            "evidenceDigest"}


class DevelopmentTlsEvidenceError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DevelopmentTlsEvidenceError(message)


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


def validate(path: Path) -> Mapping[str, Any]:
    path = path.resolve()
    require(path.is_file() and ROOT in path.parents, "development TLS evidence is missing or unscoped")
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, Mapping) and set(value) == TOP_KEYS, "development TLS evidence fields drifted")
    require(value["schemaVersion"] == 1 and value["runnerId"] == "teamaibox.spark-development-tls.v1"
            and value["status"] == "passed" and value["failure"] is None, "development TLS evidence did not pass")
    require(value["target"] == "dgx-spark-dev-01" and value["volume"] == "teamaibox-development-tls",
            "development TLS target drifted")
    require(isinstance(value["created"], bool), "development TLS creation fact drifted")
    require(value["checks"] == {"volumeOwned": True, "certificateReady": True, "privateKeyProtected": True, "keyPairMatched": True},
            "development TLS checks are incomplete")
    certificate = value["certificate"]
    require(isinstance(certificate, Mapping) and set(certificate) == {"sha256Fingerprint", "notAfter"}
            and re.fullmatch(r"[0-9A-F]{2}(?::[0-9A-F]{2}){31}", certificate["sha256Fingerprint"] or "") is not None
            and isinstance(certificate["notAfter"], str) and len(certificate["notAfter"]) >= 20,
            "development TLS certificate facts drifted")
    require(value["source"] == {"runnerDigest": digest(RUNNER.read_bytes())}, "development TLS runner changed")
    require(value["credentialsRetained"] is False and value["commandOutputRetained"] is False,
            "development TLS evidence retained sensitive output")
    without = dict(value)
    claimed = without.pop("evidenceDigest")
    require(claimed == digest(canonical(without)), "development TLS evidence digest drifted")
    return {"valid": True, "runId": value["runId"], "status": value["status"],
            "sha256Fingerprint": certificate["sha256Fingerprint"]}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (DevelopmentTlsEvidenceError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Spark development TLS evidence invalid: {error}")
        raise SystemExit(1)
