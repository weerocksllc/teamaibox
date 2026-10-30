#!/usr/bin/env python3
"""Validate the complete release-blocking operator documentation catalog."""

from __future__ import annotations

import json
import re
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "architecture" / "validation" / "operator-documentation.v1.json"
INDEX = ROOT / "docs" / "README.md"
REQUIRED_TOPICS = [
    "installation",
    "initial_admin_setup",
    "user_guide",
    "plugin_api",
    "compute_api",
    "model_certification",
    "source_offline",
    "backup_restore",
    "host_maintenance",
    "troubleshooting",
    "security_unlock",
]
PLACEHOLDERS = re.compile(r"\b(?:TODO|TBD|FIXME|coming soon|lorem ipsum)\b", re.IGNORECASE)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def repository_file(value: str) -> Path:
    require(isinstance(value, str), "documentation path must be a string")
    relative = PurePosixPath(value)
    require(not relative.is_absolute() and ".." not in relative.parts, "documentation path escapes the repository")
    path = ROOT / relative
    require(path.is_file(), f"documentation file is missing: {value}")
    return path


def headings(markdown: str) -> set[str]:
    return {match.group(1).strip() for match in re.finditer(r"^##\s+(.+?)\s*$", markdown, re.MULTILINE)}


def validate(catalog_path: Path = CATALOG) -> dict[str, Any]:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    require(catalog.get("schemaVersion") == 1, "operator documentation schemaVersion drifted")
    require(catalog.get("catalogId") == "teamaibox.operator-documentation.v1", "operator documentation catalog identity drifted")
    require(catalog.get("releaseBlocking") is True, "operator documentation must remain release blocking")
    require(catalog.get("index") == "docs/README.md", "operator documentation index drifted")

    documents = catalog.get("documents")
    require(isinstance(documents, list), "operator documentation documents must be a list")
    require([item.get("topic") for item in documents] == REQUIRED_TOPICS, "operator documentation topic coverage or order drifted")
    require(len({item.get("path") for item in documents}) == len(documents), "operator documentation paths are duplicated")

    index = repository_file(catalog["index"]).read_text(encoding="utf-8")
    require("## Install and first use" in index and "## Integrate applications and compute" in index and "## Operate and recover" in index, "documentation index sections are incomplete")
    require("single local execution agent" in index
            and "Source/build checks do not constitute" in index
            and "a deployed release" in index, "documentation index overstates release status")

    section_count = 0
    audience_set: set[str] = set()
    for document in documents:
        topic = document.get("topic", "unknown")
        path_value = document.get("path")
        path = repository_file(path_value)
        require(path.suffix == ".md" and path_value.startswith("docs/"), f"{topic} is not a docs Markdown file")
        content = path.read_text(encoding="utf-8")
        normalized_content = " ".join(content.split())
        require(content.startswith("# "), f"{topic} has no level-one title")
        require(PLACEHOLDERS.search(content) is None, f"{topic} contains a placeholder marker")

        required_sections = document.get("requiredSections")
        require(isinstance(required_sections, list) and required_sections, f"{topic} has no required sections")
        actual_headings = headings(content)
        missing_sections = [item for item in required_sections if item not in actual_headings]
        require(not missing_sections, f"{topic} is missing required sections: {missing_sections}")
        # Check useful section content, not an English whitespace word quota.
        # Chinese documentation can be complete without 120 space-delimited words.
        sections = {match.group(1).strip(): match.group(2).strip() for match in re.finditer(
            r"^##\s+(.+?)\s*\n(.*?)(?=^##\s|\Z)", content, re.MULTILINE | re.DOTALL)}
        require(all(sections.get(item) for item in required_sections), f"{topic} has empty required sections")
        section_count += len(required_sections)

        references = document.get("requiredReferences")
        require(isinstance(references, list) and references, f"{topic} has no required references")
        missing_references = [item for item in references if " ".join(item.split()) not in normalized_content]
        require(not missing_references, f"{topic} is missing required references: {missing_references}")

        audiences = document.get("audiences")
        require(isinstance(audiences, list) and audiences and all(isinstance(item, str) and item for item in audiences), f"{topic} audiences are invalid")
        audience_set.update(audiences)

        relative_from_docs = PurePosixPath(path_value).relative_to("docs").as_posix()
        require(f"({relative_from_docs})" in index, f"documentation index omits {path_value}")

    plugin = repository_file("docs/api/plugin-api-v1.md").read_text(encoding="utf-8")
    compute = repository_file("docs/api/compute-api-v1.md").read_text(encoding="utf-8")
    require("[Compute API v1](compute-api-v1.md)" in plugin, "plugin guide does not link to Compute API")
    require("durable queue" in plugin and "durable" in compute, "plugin/compute queue boundary is missing")

    installation = repository_file("docs/operations/installation.md").read_text(encoding="utf-8")
    security = repository_file("docs/operations/security-and-unlock-runbook.md").read_text(encoding="utf-8")
    require("Do not install Node.js, Python packages" in installation, "container-first host guidance is missing")
    require("data encryption is not optional" in " ".join(installation.split()) and "Startup Unlock Protection is optional" in " ".join(security.split()), "encryption/unlock distinction is missing")
    require("not release-qualified" in security, "USB hardware limitation is missing")

    return {
        "valid": True,
        "documentCount": len(documents),
        "sectionCount": section_count,
        "audienceCount": len(audience_set),
    }


if __name__ == "__main__":
    print(json.dumps(validate(), sort_keys=True, separators=(",", ":")))
