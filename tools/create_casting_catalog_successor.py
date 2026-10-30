#!/usr/bin/env python3
"""Render the current browser-only casting catalog and environment successors.

This is a documentation/catalog operation only.  It never starts a receiver,
changes a service, or promotes the still-incomplete Apple sender matrix.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OLD_CATALOG = "architecture/validation/feature-acceptance-catalog.v24.json"
OLD_MATRIX = "architecture/validation/supported-environment-matrix.v9.json"
CATALOG = "architecture/validation/feature-acceptance-catalog.v25.json"
MATRIX = "architecture/validation/supported-environment-matrix.v10.json"
GUIDE = "docs/operations/wireless-casting-guide.md"

PARENTS = {
    "runtime": "evidence/validation/components/casting-browser-runtime-component-20261016-a2.json",
    "media": "evidence/validation/components/casting-browser-media-component-20261016-a1.json",
    "journeys": "evidence/validation/components/casting-browser-journeys-component-20261016-a1.json",
    "privacy": "evidence/validation/components/casting-media-privacy-component-20261016-a1.json",
    "sourceLifecycle": "evidence/validation/components/casting-source-lifecycle-component-20261016-a1.json",
    "serviceLifecycle": "evidence/validation/feature-deployments/casting-browser-lifecycle-20261016-a4.json",
}

CASTING_KEYS = {
    "official.wireless-casting",
    "integration.airplay-receiver",
    "realtime.cast-webrtc",
}


def need(value: bool, code: str) -> None:
    if not value:
        raise ValueError(code)


def read(path: str) -> dict:
    return json.loads((ROOT / path).read_bytes())


def sha(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def binding(path: str) -> dict[str, str]:
    value = read(path)
    result = {
        "path": path,
        "fileSha256": sha((ROOT / path).read_bytes()),
        "runId": value["runId"],
    }
    if "evidenceDigest" in value:
        result["evidenceDigest"] = value["evidenceDigest"]
    return result


def parent_bindings() -> dict[str, dict[str, str]]:
    values = {name: read(path) for name, path in PARENTS.items()}
    for name, value in values.items():
        need(value.get("status") == "passed", f"parent_not_passed:{name}")
    need(values["runtime"].get("strictVerified") is True
         and values["runtime"].get("task22_3Accepted") is True
         and values["runtime"].get("appleSenderAccepted") is False
         and values["runtime"].get("productAccepted") is False,
         "runtime_claim_changed")
    need(values["media"].get("claims", {}).get("openSpecTasksClosed") == ["22.7"]
         and values["media"].get("claims", {}).get("productAccepted") is False,
         "media_claim_changed")
    need(values["journeys"].get("claims", {}).get("openSpecTasksClosed") == ["22.11"]
         and values["journeys"].get("claims", {}).get("appleSenderAccepted") is False
         and values["journeys"].get("claims", {}).get("productAccepted") is False,
         "journey_claim_changed")
    need(values["privacy"].get("claims", {}).get("openSpecTasksClosed") == ["22.8"]
         and values["privacy"].get("claims", {}).get("productAccepted") is False,
         "privacy_claim_changed")
    need(values["sourceLifecycle"].get("task22_17Accepted") is True
         and values["sourceLifecycle"].get("appleSenderLiveAccepted") is False
         and values["sourceLifecycle"].get("productAccepted") is False,
         "source_lifecycle_claim_changed")
    need(values["serviceLifecycle"].get("productAccepted") is False
         and values["serviceLifecycle"].get("appleSenderAccepted") is False,
         "service_lifecycle_claim_changed")
    return {name: binding(path) for name, path in PARENTS.items()}


def guide_policy() -> None:
    guide = (ROOT / GUIDE).read_text(encoding="utf-8")
    required = (
        "同一局域网", "随机生成", "指定用户", "指定团队", "可发现",
        "自动加入观看", "自动播放", "来源已断开", "重新连接", "默认不录制",
        "观看人数按可用资源决定", "FairPlay/DRM", "协议版本", "没有画面时",
        "回滚", "不再支持 HDMI",
    )
    for phrase in required:
        need(phrase in guide, f"guide_missing:{phrase}")
    need("Apple 认证 AirPlay Receiver" not in guide, "guide_overclaims_apple_certification")


def expected() -> dict[str, dict]:
    guide_policy()
    parents = parent_bindings()
    catalog = copy.deepcopy(read(OLD_CATALOG))
    previous = copy.deepcopy(catalog)
    catalog.update(
        schemaVersion=25,
        catalogId="teamaibox.feature-acceptance.v25",
        publishedAt="2026-10-16",
        scope="Current browser-only casting components and protected office baseline; complete Apple sender acceptance remains pending",
        successor={
            "historicalCatalog": {
                "path": OLD_CATALOG,
                "fileSha256": sha((ROOT / OLD_CATALOG).read_bytes()),
            },
            "castingEvidence": parents,
            "documentation": {
                "path": GUIDE,
                "fileSha256": sha((ROOT / GUIDE).read_bytes()),
            },
        },
    )

    found: set[str] = set()
    for feature in catalog["features"]:
        key = feature["key"]
        if key not in CASTING_KEYS:
            continue
        found.add(key)
        need(feature.get("mandatory") is True, f"casting_feature_not_mandatory:{key}")
        need(feature.get("ownerTaskId") == {
            "official.wireless-casting": "22.11",
            "integration.airplay-receiver": "22.10",
            "realtime.cast-webrtc": "22.11",
        }[key], f"casting_owner_changed:{key}")
        if key == "official.wireless-casting":
            feature["acceptance"] = {
                "state": "browser-journeys-accepted",
                "productAccepted": False,
                "evidence": [parents[name] for name in ("runtime", "journeys", "privacy", "serviceLifecycle")],
                "blockers": ["22.10", "22.12", "22.13"],
            }
            feature["limitations"] = [
                "Current browser workbench and authorization journeys passed; complete Apple sender coverage has not.",
                "One and eight browser windows are acceptance tiers, not a fixed product concurrency limit.",
                "Browser-only delivery is current; HDMI casting is retired and not an automatic fallback.",
            ]
        elif key == "realtime.cast-webrtc":
            feature["acceptance"] = {
                "state": "browser-media-component-accepted",
                "productAccepted": False,
                "evidence": [parents[name] for name in ("media", "journeys", "sourceLifecycle")],
                "blockers": ["22.10", "22.12", "22.13"],
            }
            feature["limitations"] = [
                "Authenticated encrypted browser media, source lifecycle and the one/eight-window component envelope passed.",
                "Calibrated glass-to-glass latency, measured audible A/V sync and the complete failure matrix remain pending.",
            ]
        else:
            feature["acceptance"] = {
                "state": "mandatory-current-sender-validation-pending",
                "productAccepted": False,
                "evidence": [parents[name] for name in ("runtime", "sourceLifecycle")],
                "blockers": ["22.10", "22.12", "22.13"],
            }
            feature["limitations"] = [
                "This mandatory feature is not optional or disabled, but iPhone evidence does not substitute for iPad and macOS coverage.",
                "Unpaired, replayed, downgraded and legacy plaintext sender paths remain fail-closed.",
                "FairPlay/DRM content and unproven sender/protocol versions are unsupported.",
            ]
        feature.pop("optionalDisabled", None)

    need(found == CASTING_KEYS, "required_casting_features_missing")
    need([feature for feature in catalog["features"] if feature["key"] not in CASTING_KEYS]
         == [feature for feature in previous["features"] if feature["key"] not in CASTING_KEYS],
         "unrelated_catalog_feature_changed")
    need(catalog["retiredFeatures"] == [{
        "key": "integration.hdmi-cast-output",
        "state": "retired",
        "passed": False,
        "reason": "User confirmed browser-only casting; preserve old HDMI evidence.",
    }], "hdmi_retirement_changed")
    catalog["technicalClosure"].update(
        featureCount=len(catalog["features"]),
        productAcceptedCount=sum(feature["acceptance"]["productAccepted"] for feature in catalog["features"]),
        task20_1Satisfied=False,
        formalReleaseAccepted=False,
    )
    catalog["releaseAggregation"]["statement"] = (
        "Browser-only casting control, WebRTC components, privacy, lifecycle and browser authorization are current. "
        "The mandatory AirPlay-compatible receiver remains blocked on complete Apple sender, failure and calibrated performance gates."
    )

    matrix = copy.deepcopy(read(OLD_MATRIX))
    matrix.update(
        schemaVersion=10,
        matrixId="teamaibox.supported-environment.v10",
        publishedAt="2026-10-16",
        scope="Current browser-only casting component envelope plus the accepted no-cast office baseline",
        successor={
            "historicalMatrix": {
                "path": OLD_MATRIX,
                "fileSha256": sha((ROOT / OLD_MATRIX).read_bytes()),
            },
            "catalogId": catalog["catalogId"],
            "castingEvidence": parents,
        },
        historicalEnvironmentPolicy="Prior Windows and no-cast office records remain unchanged; this successor adds only the current browser-casting component envelope.",
    )
    matrix["environments"].append({
        "key": "main-box-browser-only-casting-components",
        "state": "component-accepted",
        "nodeRole": "main-box",
        "delivery": "authorized system-trust HTTPS/WebRTC browsers only",
        "acceptanceTiers": {"browserViewers": [1, 8], "hardProductLimit": False},
        "evidence": parents,
        "scope": {
            "browserControlAndAuthorization": True,
            "browserMediaComponent": True,
            "sourceLifecycleReconciliation": True,
            "privacyAndCleanup": True,
            "serviceLifecycle": True,
            "completeAppleSenderMatrix": False,
            "completeFailureMatrix": False,
            "calibratedEndToEndPerformance": False,
            "productAccepted": False,
            "hdmiCasting": False,
        },
        "limitations": [
            "Complete iPhone, iPad and macOS sender coverage remains owned by task 22.10.",
            "Unproven Apple sender/protocol versions and FairPlay/DRM content are unsupported.",
            "No HDMI casting fallback or physical display prerequisite exists.",
        ],
    })
    matrix["currentDeployment"].update(
        browserCastingComponentAccepted=True,
        airplaySenderProductAccepted=False,
        castingProductAccepted=False,
        technicalWholeProductAccepted=False,
        task20_1Satisfied=False,
        formalReleaseAccepted=False,
    )
    if GUIDE not in matrix["documentation"]:
        matrix["documentation"].append(GUIDE)
    matrix["releaseBlockers"] = list(dict.fromkeys([
        "22.10", "22.12", "22.13", *matrix["releaseBlockers"],
    ]))
    return {CATALOG: catalog, MATRIX: matrix}


def validate_documents(documents: dict[str, dict]) -> dict[str, object]:
    need(documents == expected(), "casting_catalog_or_matrix_changed")
    catalog = documents[CATALOG]
    by_key = {feature["key"]: feature for feature in catalog["features"]}
    for key in CASTING_KEYS:
        need(by_key[key]["mandatory"] is True, f"mandatory_feature_changed:{key}")
        need("optionalDisabled" not in by_key[key], f"optional_disabled_reintroduced:{key}")
    need(by_key["integration.airplay-receiver"]["acceptance"]["productAccepted"] is False,
         "airplay_product_acceptance_overclaimed")
    need(catalog["retiredFeatures"][0]["passed"] is False,
         "hdmi_retirement_marked_passed")
    return {
        "valid": True,
        "featureCount": len(catalog["features"]),
        "mandatoryCastingFeatureCount": 3,
        "browserJourneysAccepted": True,
        "browserMediaComponentAccepted": True,
        "airplaySenderProductAccepted": False,
        "hdmiCastingRetiredWithoutPass": True,
        "task22_15Accepted": True,
        "productAccepted": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args()
    documents = expected()
    if args.write:
        for path, value in documents.items():
            target = ROOT / path
            target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"written": list(documents)}, ensure_ascii=False))
        return
    print(json.dumps(validate_documents({path: read(path) for path in documents}), ensure_ascii=False))


if __name__ == "__main__":
    main()
