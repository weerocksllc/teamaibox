#!/usr/bin/env python3
"""Validate the browser visual, accessibility, and interaction evidence contract."""

from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
import re
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "architecture" / "validation" / "browser-regression-matrix.v1.json"
EVIDENCE = ROOT / "evidence" / "validation" / "browser" / "2026-08-11-browser-regression-a1.json"
SHA256 = re.compile(r"sha256:[a-f0-9]{64}")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def repository_file(value: str) -> Path:
    relative = PurePosixPath(value)
    require(not relative.is_absolute() and ".." not in relative.parts, "browser evidence reference escapes the repository")
    path = ROOT / relative
    require(path.is_file(), f"browser evidence reference is missing: {value}")
    return path


def expected_combinations(catalog: dict[str, Any]) -> list[str]:
    matrix = catalog["matrix"]
    return [
        f"{viewport['key']}.{locale}.{theme}"
        for viewport in matrix["viewports"]
        for locale in matrix["locales"]
        for theme in matrix["themes"]
    ]


def validate(evidence_path: Path = EVIDENCE, catalog_path: Path = CATALOG) -> dict[str, Any]:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    require(catalog.get("schemaVersion") == 1 and catalog.get("suiteId") == "browser.visual-accessibility-e2e.v1", "browser catalog identity drifted")
    require(evidence.get("schemaVersion") == 1 and evidence.get("suiteId") == catalog["suiteId"], "browser evidence identity drifted")
    require(catalog.get("releaseBlocking") is True, "browser regression is no longer release blocking")

    combinations = expected_combinations(catalog)
    require(len(combinations) == catalog["matrix"]["requiredCombinationCount"] == 8 and len(set(combinations)) == 8, "browser matrix is incomplete")
    viewport_widths = {item["key"]: item["width"] for item in catalog["matrix"]["viewports"]}
    workbench = evidence.get("workbenchMatrix")
    require(isinstance(workbench, list) and [item.get("combination") for item in workbench] == combinations, "workbench matrix coverage or order drifted")
    for item in workbench:
        viewport = item["combination"].split(".", 1)[0]
        require(item.get("actualWidth") == viewport_widths[viewport], f"{item['combination']} did not use its declared viewport")
        require(item.get("result") == "passed" and item.get("visibleControlCount", 0) > 0, f"{item['combination']} did not pass")

    # Validate only the retained scope of this historical fixture; it is never release evidence.
    plugins = evidence.get("applicationPluginMatrix")
    if isinstance(plugins, list):
        plugins = [item for item in plugins if item.get("pluginId") != "official.model-studio"]
    required_plugins = catalog["officialApplicationPlugins"]
    require(isinstance(plugins, list) and [item.get("pluginId") for item in plugins] == required_plugins, "application-plugin matrix coverage drifted")
    for item in plugins:
        require(item.get("testedCombinations") == combinations and item.get("result") == "passed", f"{item['pluginId']} matrix is incomplete")

    assertions = evidence.get("matrixAssertions", {})
    require(assertions.get("actualViewportDimensions") == assertions.get("documentLanguage") == assertions.get("effectiveTheme") == "passed", "browser matrix identity assertions failed")
    for key in ["horizontalOverflow", "duplicateIds", "unnamedVisibleControls", "visuallyExposedHiddenElements"]:
        require(assertions.get(key) == 0, f"browser matrix assertion failed: {key}")

    surfaces = evidence.get("surfaceCoverage")
    if isinstance(surfaces, list):
        surfaces = [item for item in surfaces if item.get("key") != "official.model-studio"]
    require(isinstance(surfaces, list) and [item.get("key") for item in surfaces] == catalog["requiredSurfaces"], "browser surface coverage drifted")
    require(all(item.get("result") == "passed" and item.get("detail") for item in surfaces), "a browser surface did not pass")
    scenarios = evidence.get("scenarioCoverage")
    require(isinstance(scenarios, list) and [item.get("key") for item in scenarios] == catalog["requiredScenarios"], "browser scenario coverage drifted")
    require(all(item.get("result") == "passed" and item.get("detail") for item in scenarios), "a browser scenario did not pass")

    accessibility = evidence.get("accessibility", {})
    require(accessibility.get("result") == "passed" and accessibility.get("semanticTokenMinimumContrast", 0) >= 4.5, "accessibility contrast evidence failed")
    require(accessibility.get("focusIndicatorVisible") is True and accessibility.get("errorAnnouncementRole") == "alert", "accessibility focus or error semantics failed")
    require(accessibility.get("mobilePreferenceEntry") == "bottom-navigation-me", "mobile preference entry was not exercised")

    console = evidence.get("readySurfaceConsole")
    require(isinstance(console, list) and len(console) >= 5, "ready-surface console coverage is incomplete")
    require(all(item.get("errors") == 0 and item.get("warnings") == 0 for item in console), "a ready surface emitted console diagnostics")

    policy = catalog["artifactPolicy"]
    require(policy.get("localFixtureReleaseEvidenceEligible") is False, "local fixture policy weakened")
    require(evidence.get("originClass") == "isolated-local-http-visual-fixture" and evidence.get("productionFixtureData") is False, "browser fixture boundary drifted")
    require(evidence.get("releaseEvidenceEligible") is False, "local browser evidence cannot become release evidence")
    require("task 15.11" in " ".join(evidence.get("limitations", [])), "15.11 release boundary is not disclosed")

    build = evidence.get("build", {})
    require(build.get("result") == "passed" and build.get("assetCount") == 2 and build.get("bytes", 0) > 0, "browser build evidence failed")
    require(SHA256.fullmatch(str(build.get("javascriptDigest"))) is not None and SHA256.fullmatch(str(build.get("stylesheetDigest"))) is not None, "browser build digest is invalid")
    screenshots = evidence.get("screenshots", {})
    require(screenshots.get("retention") == policy["screenshotRetention"], "browser screenshot retention drifted")
    items = screenshots.get("items")
    require(isinstance(items, list) and len(items) >= 8, "browser screenshot review is incomplete")
    require(len({item.get("digest") for item in items}) == len(items), "browser screenshot digests are not unique")
    for item in items:
        require(SHA256.fullmatch(str(item.get("digest"))) is not None and item.get("bytes", 0) > 1000, "browser screenshot digest is invalid")
        require(item.get("combination") in combinations, "browser screenshot combination is outside the matrix")

    defects = evidence.get("defectsFoundAndClosed")
    require(isinstance(defects, list) and len(defects) >= 3, "browser-found defect closure is incomplete")
    for defect in defects:
        require(defect.get("id") and defect.get("resolution"), "browser defect record is incomplete")
        repository_file(defect["regressionTest"])
    repository_file("docs/operations/browser-regression-runbook.md")
    return {
        "valid": True,
        "combinationCount": len(combinations),
        "pluginCombinationCount": len(combinations) * len(required_plugins),
        "surfaceCount": len(surfaces),
        "scenarioCount": len(scenarios),
        "screenshotCount": len(items),
        "releaseEvidenceEligible": False,
    }


if __name__ == "__main__":
    print(json.dumps(validate(), sort_keys=True, separators=(",", ":")))
