#!/usr/bin/env python3
"""Fail closed if the initial official catalog grows a built-in video generator."""
from __future__ import annotations
import json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parents[1]
POLICY = ROOT / "architecture/validation/initial-catalog-policy.v2.json"

def require(value: bool, message: str) -> None:
    if not value: raise ValueError(message)

def validate() -> dict[str, int]:
    policy = json.loads(POLICY.read_text())
    require(policy.get("schemaVersion") == 1, "initial catalog policy version is invalid")
    workbench = (ROOT / "apps/web/src/workbench-data.ts").read_text()
    category_order = {key: int(order) for key, order in re.findall(r'key:\s*"([a-z][a-z0-9-]+)"[^\n]+order:\s*([0-9]+)', workbench)}
    require(set(category_order) == {"collaboration", "ai-application", "professional"}, "initial application categories drifted")
    manifests = sorted((ROOT / "apps").glob("*-plugin/manifest.release-template.json"))
    documents = [json.loads(path.read_text()) for path in manifests]
    plugin_ids = sorted(document["id"] for document in documents)
    require(plugin_ids == sorted(policy["firstPartyContainerPluginIds"]), "first-party container plugin catalog drifted")
    built_ins_path = ROOT / "deploy/applications/built-in-applications.v1.json"
    built_ins = json.loads(built_ins_path.read_text())
    application_facts = [{"id": item["applicationKey"], "category": item["ui"]["categoryKey"], "order": item["ui"]["order"]} for item in built_ins.get("applications", [])]
    # Match the Web catalog's existing manifest-category alias. Do not put
    # virtual phones/computers in an accidental unknown-category tail.
    application_facts.extend({"id": item["id"], "category": {"professional-tool": "professional"}.get(item["ui"]["category"], item["ui"]["category"]), "order": item["ui"]["order"]} for item in documents)
    application_ids = [item["id"] for item in sorted(application_facts, key=lambda item: (category_order.get(item["category"], 10_000), item["order"], item["id"]))]
    require(application_ids == policy["firstPartyApplicationIds"], "initial application catalog drifted")
    matrix = json.loads((ROOT / "models/candidate-matrix.v1.json").read_text())
    require(matrix.get("coverage") == policy["candidateWorkloadCoverage"], "initial model workload coverage drifted")
    inspected = [workbench, built_ins_path.read_text(), json.dumps(documents, sort_keys=True), json.dumps(matrix.get("coverage")),
                 (ROOT / "deploy/web/compose.yaml").read_text(), (ROOT / "deploy/web/development.compose.yaml").read_text()]
    normalized = "\n".join(inspected).lower()
    for term in policy["forbiddenBuiltInApplicationTerms"] + policy["forbiddenResidentWorkerTerms"]:
        require(term not in normalized, f"forbidden initial video-generation term found: {term}")
    require(policy.get("futureSupportPolicy") == "separately-signed-plugin-and-compatible-certified-profile-required", "future video support gate is invalid")
    return {"applications": len(application_ids), "containerPlugins": len(plugin_ids), "candidateWorkloads": len(matrix["coverage"])}

if __name__ == "__main__":
    summary = validate()
    print(f"initial catalog valid: {summary['applications']} apps, {summary['containerPlugins']} container plugins, no built-in video generation")
