#!/usr/bin/env python3
"""Strictly validate capability dependency aggregation evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tools/create_capability_dependency_evidence.py"
HISTORICAL_CATALOGS = ROOT / "architecture/validation/historical-feature-catalog-digests.v1.json"
if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))


class ValidationFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationFailure(message)


def digest(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def canonical(value: dict[str, Any]) -> str:
    payload = dict(value); payload.pop("evidenceDigest", None)
    return digest(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())


def validate(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    require(resolved.is_file() and ROOT in resolved.parents, "dependency evidence is unscoped")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    require(value.get("schemaVersion") == 1 and value.get("runnerId") == "teamaibox.capability-dependency-acceptance.v1"
        and value.get("status") == "passed" and value.get("evidenceDigest") == canonical(value),
        "dependency evidence identity or digest drifted")
    require(value.get("source") == {"runnerDigest": digest(RUNNER.read_bytes())}, "dependency runner drifted")
    from tools.create_capability_dependency_evidence import TARGETS, EXTRA
    require(value.get("targets") == TARGETS, "dependency target mapping drifted")
    accepted_catalogs = {item.get("digest") for item in
        json.loads(HISTORICAL_CATALOGS.read_text(encoding="utf-8")).get("retiredCatalogDigests", [])}
    accepted_catalogs.add(digest((ROOT / "architecture/validation/feature-acceptance-catalog.v1.json").read_bytes()))
    require(value.get("sourceCatalogDigest") in accepted_catalogs, "dependency source catalog is not allowlisted")
    expected_sources = {item for items in TARGETS.values() for item in items}
    require(set(value.get("sources", {})) == expected_sources, "dependency source feature coverage drifted")
    for source_key, source in value["sources"].items():
        require(isinstance(source.get("ownerTaskId"), str) and source.get("evidence"),
            f"dependency source is incomplete: {source_key}")
        for item in source["evidence"]:
            evidence_path = (ROOT / item.get("path", "")).resolve()
            require(evidence_path.is_file() and ROOT in evidence_path.parents
                and item.get("digest") == digest(evidence_path.read_bytes()),
                f"dependency source evidence drifted: {source_key}/{item.get('class')}")
    require(set(value.get("extras", {})) == set(EXTRA), "dependency extra coverage drifted")
    for key, relative in EXTRA.items():
        item = value["extras"][key]; evidence_path = ROOT / relative
        child = json.loads(evidence_path.read_text(encoding="utf-8"))
        require(item == {"path": relative, "digest": digest(evidence_path.read_bytes()), "runId": child["runId"]}
            and (child.get("status") == "passed" or child.get("outcome") == "passed"),
            f"dependency extra evidence drifted: {key}")
    require(value.get("claimBoundary") == {"componentReadyOnly": True, "productAccepted": False,
        "embeddings": "not_claimed", "speechWebSocket": "not_claimed", "adminStorage": "not_claimed",
        "encryptedUnlock": "not_claimed", "trustedHttps": "not_satisfied_by_self_signed_component_origins",
        "independentHumanAcceptance": "not_performed"}, "dependency claim boundary drifted")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--evidence", type=Path, required=True)
    value = validate(parser.parse_args().evidence)
    print(json.dumps({"runId": value["runId"], "status": "passed", "targetCount": len(value["targets"]),
        "sourceFeatureCount": len(value["sources"])}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationFailure, OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"capability dependency evidence invalid: {error}")
        raise SystemExit(1)
