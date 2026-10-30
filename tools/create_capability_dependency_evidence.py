#!/usr/bin/env python3
"""Bind pending protocol/capability surfaces to their already accepted vertical-slice evidence."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "architecture/validation/feature-acceptance-catalog.v1.json"
OUTPUT_ROOT = ROOT / "evidence/validation/acceptance"
RUN_ID = re.compile(r"capability-dependencies-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}")
TARGETS = {
    "integration.local-identity": ["admin.users", "admin.roles", "admin.team"],
    "integration.plugin-lifecycle": ["admin.plugins"],
    "integration.agent-opencode-sandbox": ["official.assistant", "admin.plugins", "admin.sources"],
    "integration.object-handoff": ["official.team-drive", "official.drawing", "official.ocr", "official.asr", "official.translation"],
    "realtime.assistant-sse": ["official.assistant"],
    "realtime.messaging-sse": ["official.messaging"],
    "compute.responses": ["official.assistant", "integration.managed-node", "integration.external-compute"],
    "compute.chat-completions": ["official.assistant", "integration.external-compute"],
    "compute.image-generation": ["official.drawing"],
    "compute.ocr": ["official.ocr"],
    "compute.asr": ["official.asr", "integration.managed-node"],
    "compute.translation": ["official.translation", "integration.external-compute"],
}
EXTRA = {
    "schedulerMatrix": "evidence/validation/cluster/scheduler-matrix-20260821-a1.json",
    "realExternalRouting": "evidence/validation/cluster/real-external-provider-routing-20260821-a6.json",
}


class EvidenceFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise EvidenceFailure(message)


def digest(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def canonical(value: dict[str, Any]) -> str:
    payload = dict(value); payload.pop("evidenceDigest", None)
    return digest(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    require(RUN_ID.fullmatch(args.run_id) is not None, "run ID is invalid")
    output = OUTPUT_ROOT / f"{args.run_id}.json"
    require(not output.exists(), "evidence already exists; use a new immutable run ID")
    catalog_bytes = CATALOG.read_bytes()
    catalog = json.loads(catalog_bytes)
    features = {item["key"]: item for item in catalog["features"]}
    sources: dict[str, Any] = {}
    for source_key in sorted({item for items in TARGETS.values() for item in items}):
        source = features[source_key]
        acceptance = source["acceptance"]
        require(acceptance["state"] == "component-ready" and acceptance["evidence"],
            f"source feature is not component-ready: {source_key}")
        evidence = []
        for item in acceptance["evidence"]:
            path = (ROOT / item["path"]).resolve()
            require(path.is_file() and ROOT in path.parents and digest(path.read_bytes()) == item["digest"],
                f"source evidence drifted: {source_key}/{item['class']}")
            evidence.append(item)
        sources[source_key] = {"ownerTaskId": source["ownerTaskId"], "evidence": evidence}
    extras = {}
    for key, relative in EXTRA.items():
        path = ROOT / relative
        value = json.loads(path.read_text(encoding="utf-8"))
        require(value.get("status") == "passed" or value.get("outcome") == "passed",
            f"extra evidence did not pass: {key}")
        extras[key] = {"path": relative, "digest": digest(path.read_bytes()), "runId": value["runId"]}
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    report = {"schemaVersion": 1, "runnerId": "teamaibox.capability-dependency-acceptance.v1",
        "runId": args.run_id, "status": "passed", "completedAt": now,
        "sourceCatalogDigest": digest(catalog_bytes), "targets": TARGETS, "sources": sources, "extras": extras,
        "claimBoundary": {"componentReadyOnly": True, "productAccepted": False,
            "embeddings": "not_claimed", "speechWebSocket": "not_claimed",
            "adminStorage": "not_claimed", "encryptedUnlock": "not_claimed",
            "trustedHttps": "not_satisfied_by_self_signed_component_origins",
            "independentHumanAcceptance": "not_performed"},
        "privacy": {"credentialsRetained": False, "userContentRetained": False,
            "commandOutputRetained": False}, "source": {"runnerDigest": digest(Path(__file__).read_bytes())}}
    report["evidenceDigest"] = canonical(report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"runId": args.run_id, "status": "passed", "targetCount": len(TARGETS),
        "sourceFeatureCount": len(sources), "evidence": output.relative_to(ROOT).as_posix()}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (EvidenceFailure, OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"capability dependency evidence failed: {error}")
        raise SystemExit(1)
