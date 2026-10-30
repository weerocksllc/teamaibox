#!/usr/bin/env python3
"""Strict validation for the versioned Team AI Box Drawing model portfolio."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PORTFOLIO = ROOT / "models" / "drawing-model-portfolio.v1.json"
HEX_REVISION = re.compile(r"^[a-f0-9]{40}$")
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
ID = re.compile(r"^[a-z0-9][a-z0-9.-]+$")
REQUIRED_ALIASES = {
    "drawing.automatic", "drawing.fast", "drawing.high-quality",
    "drawing.chinese-poster", "drawing.infographic", "drawing.edit",
    "drawing.external-quality", "drawing.legacy",
}
REQUIRED_LOCAL = {
    "flux2-klein-4b-bf16", "flux2-klein-4b-nvfp4", "z-image-turbo",
    "sensenova-u1.5-8b-mot", "glm-image", "longcat-image",
    "longcat-image-edit-turbo", "qwen-image-2512",
    "qwen-image-2512-lightning",
    "sdxl-base-1.0-fp16",
}
REQUIRED_EXTERNAL = {"qwen-image-3.0-pro", "wan2.7-image-pro"}


class PortfolioError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PortfolioError(message)


def canonical_digest(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def exact(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    require(isinstance(value, dict) and set(value) == keys,
            f"{label} must contain exactly {sorted(keys)}")
    return value


def unique(items: list[dict[str, Any]], key: str, label: str) -> dict[str, dict[str, Any]]:
    require(isinstance(items, list) and items, f"{label} must not be empty")
    indexed: dict[str, dict[str, Any]] = {}
    for item in items:
        item_id = item.get(key)
        require(isinstance(item_id, str) and ID.fullmatch(item_id) is not None,
                f"{label} contains an invalid {key}")
        require(item_id not in indexed, f"{label} contains duplicate {item_id}")
        indexed[item_id] = item
    return indexed


def validate(portfolio: dict[str, Any]) -> dict[str, int]:
    exact(portfolio, {"schemaVersion", "portfolioId", "researchSnapshotAt", "target",
          "routingRules", "localCandidates", "externalCandidates", "namingClarifications"}, "portfolio")
    require(portfolio["schemaVersion"] == 1 and portfolio["portfolioId"] == "teamaibox.drawing.portfolio.v1",
            "Drawing portfolio identity drifted")
    require(portfolio["researchSnapshotAt"].endswith("Z"), "research snapshot must be UTC")
    require(portfolio["target"] == {"architecture": "linux/arm64/v8", "accelerator": "nvidia-gb10-blackwell",
            "unifiedMemoryBytes": 137438953472, "containerFirst": True}, "Spark target drifted")

    local = unique(portfolio["localCandidates"], "candidateId", "localCandidates")
    external = unique(portfolio["externalCandidates"], "candidateId", "externalCandidates")
    require(set(local) == REQUIRED_LOCAL, "local Drawing candidate coverage drifted")
    require(set(external) == REQUIRED_EXTERNAL, "external Drawing candidate coverage drifted")

    capability_keys = {"generation", "editing", "multiReference", "bilingualText"}
    for candidate_id, candidate in local.items():
        exact(candidate, {"candidateId", "displayName", "source", "license", "engine", "capabilities",
              "runtime", "lifecycle", "dependencies"}, candidate_id)
        source = exact(candidate["source"], {"publisher", "repository", "revision", "reportedBytes",
                       "artifactManifestDigest"}, f"{candidate_id}.source")
        require(HEX_REVISION.fullmatch(source["revision"]) is not None,
                f"{candidate_id} source is not immutable")
        require(isinstance(source["reportedBytes"], int) and source["reportedBytes"] > 0,
                f"{candidate_id} reported bytes are invalid")
        require(DIGEST.fullmatch(source["artifactManifestDigest"]) is not None,
                f"{candidate_id} artifact manifest is not pinned")
        license_record = exact(candidate["license"], {"identifier", "evidencePath", "evidenceDigest",
                               "reviewState"}, f"{candidate_id}.license")
        require(DIGEST.fullmatch(license_record["evidenceDigest"]) is not None,
                f"{candidate_id} license evidence is not pinned")
        require(license_record["reviewState"] in {"approved", "approved-with-use-restrictions"},
                f"{candidate_id} license is not approved")
        engine = exact(candidate["engine"], {"name", "pipeline", "compatibility"}, f"{candidate_id}.engine")
        require(all(isinstance(engine[key], str) and engine[key] for key in engine),
                f"{candidate_id} engine support is incomplete")
        caps = exact(candidate["capabilities"], capability_keys, f"{candidate_id}.capabilities")
        require(all(isinstance(caps[key], bool) for key in ("generation", "editing", "multiReference")),
                f"{candidate_id} capability flags must be boolean")
        runtime = exact(candidate["runtime"], {"precision", "inferenceSteps", "resourceMode"},
                        f"{candidate_id}.runtime")
        require(isinstance(runtime["inferenceSteps"], int) and runtime["inferenceSteps"] > 0,
                f"{candidate_id} inference steps are invalid")
        lifecycle = exact(candidate["lifecycle"], {"state", "automaticEligible", "downloadState"},
                          f"{candidate_id}.lifecycle")
        require(lifecycle["automaticEligible"] is False, f"{candidate_id} cannot be auto-routed before evidence")
        require(lifecycle["state"] in {"planned", "legacy-experimental"}, f"{candidate_id} lifecycle is invalid")
        require(lifecycle["downloadState"] in {"not-downloaded", "deployed"},
                f"{candidate_id} download state is invalid")
        require(isinstance(candidate["dependencies"], list) and
                all(item in local and item != candidate_id for item in candidate["dependencies"]),
                f"{candidate_id} dependency is invalid")

    require(local["z-image-turbo"]["capabilities"]["editing"] is False,
            "Z-Image-Turbo must remain generation-only")
    require(local["longcat-image-edit-turbo"]["capabilities"]["generation"] is False,
            "LongCat Edit Turbo must remain edit-only")
    require(local["sdxl-base-1.0-fp16"]["lifecycle"]["state"] == "legacy-experimental",
            "SDXL must remain a truthful legacy profile")
    require(local["flux2-klein-4b-nvfp4"]["runtime"]["precision"] == "nvfp4",
            "the fast FLUX.2 profile must preserve official NVFP4 identity")

    for candidate_id, candidate in external.items():
        exact(candidate, {"candidateId", "provider", "modelId", "contractUri", "contractFacts", "contractSnapshotDigest",
              "capabilities", "dataPolicy", "lifecycle"}, candidate_id)
        require(candidate["modelId"] == candidate_id and candidate["contractUri"].startswith("https://"),
                f"{candidate_id} provider contract is invalid")
        require(DIGEST.fullmatch(candidate["contractSnapshotDigest"]) is not None,
                f"{candidate_id} provider contract snapshot is not pinned")
        facts = exact(candidate["contractFacts"], {"modelId", "generation", "editing", "maxReferenceImages",
                      "maxGenerationPixels", "maxEditPixels"}, f"{candidate_id}.contractFacts")
        require(facts["modelId"] == candidate_id and facts["generation"] is True and facts["editing"] is True and
                isinstance(facts["maxReferenceImages"], int) and facts["maxReferenceImages"] > 0,
                f"{candidate_id} provider contract facts are invalid")
        require(canonical_digest(facts) == candidate["contractSnapshotDigest"],
                f"{candidate_id} provider contract fact digest drifted")
        require(candidate["dataPolicy"] == "external-processing-requires-admin-policy-and-user-disclosure",
                f"{candidate_id} external data boundary drifted")
        require(candidate["lifecycle"] == {"state": "provider-advertised", "automaticEligible": False},
                f"{candidate_id} cannot be enabled without provider validation")

    rules = exact(portfolio["routingRules"], {"automaticAlias", "requireAvailableProfile",
                  "discloseActualProfile", "discloseExternalProcessing", "excludeLegacyFromAutomatic",
                  "candidateIsNotCertified", "aliases"}, "routingRules")
    require(rules["automaticAlias"] == "drawing.automatic" and
            all(rules[key] is True for key in ("requireAvailableProfile", "discloseActualProfile",
                "discloseExternalProcessing", "excludeLegacyFromAutomatic", "candidateIsNotCertified")),
            "fail-closed Drawing routing rules drifted")
    aliases = unique(rules["aliases"], "alias", "routing aliases")
    require(set(aliases) == REQUIRED_ALIASES, "Drawing intent alias coverage drifted")
    for alias, route in aliases.items():
        exact(route, {"alias", "inputKinds", "strategy", "localCandidates", "externalCandidates"}, alias)
        require(isinstance(route["inputKinds"], list) and route["inputKinds"] and
                isinstance(route["strategy"], str) and route["strategy"], f"{alias} route is incomplete")
        require(len(route["localCandidates"]) == len(set(route["localCandidates"])) and
                set(route["localCandidates"]) <= set(local), f"{alias} has invalid local candidates")
        require(len(route["externalCandidates"]) == len(set(route["externalCandidates"])) and
                set(route["externalCandidates"]) <= set(external), f"{alias} has invalid external candidates")
        require(route["localCandidates"] or route["externalCandidates"], f"{alias} has no route")
        if "image" in route["inputKinds"] and alias not in {"drawing.automatic", "drawing.external-quality"}:
            require(all(local[item]["capabilities"]["editing"] for item in route["localCandidates"]),
                    f"{alias} contains a generation-only local profile")
    require("sdxl-base-1.0-fp16" not in aliases["drawing.automatic"]["localCandidates"],
            "automatic routing must exclude legacy SDXL")
    require(set(aliases["drawing.fast"]["localCandidates"]) == {"flux2-klein-4b-nvfp4", "z-image-turbo"},
            "fast routing candidate set drifted")

    clarifications = portfolio["namingClarifications"]
    require(isinstance(clarifications, list) and len(clarifications) == 1 and
            clarifications[0].get("ambiguousName") == "Qwen Image Turbo" and
            "No official local checkpoint" in clarifications[0].get("resolution", ""),
            "ambiguous Qwen Image Turbo naming must be resolved explicitly")
    return {"aliases": len(aliases), "localCandidates": len(local), "externalCandidates": len(external),
            "plannedCandidates": sum(item["lifecycle"]["state"] == "planned" for item in local.values())}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--portfolio", type=Path, default=PORTFOLIO)
    args = parser.parse_args()
    result = validate(json.loads(args.portfolio.resolve().read_text(encoding="utf-8")))
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, json.JSONDecodeError, PortfolioError) as error:
        raise SystemExit(f"Drawing model portfolio validation failed: {error}")
