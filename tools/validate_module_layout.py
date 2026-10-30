#!/usr/bin/env python3
"""Validate the versioned Team AI Box module catalog and workspace layout."""

from __future__ import annotations

import json
import pathlib
import re
from collections import defaultdict
from typing import Any, Mapping


ROOT = pathlib.Path(__file__).resolve().parents[1]
CATALOG = ROOT / "architecture" / "module-catalog.json"
REQUIRED_COMPONENTS = {
    "agent-bridge",
    "compute-gateway",
    "contracts",
    "event-bus",
    "messaging",
    "node-agent",
    "object-service",
    "persistence",
    "platform-api",
    "plugin-runtime",
    "scheduler",
    "source-gateway",
    "web-shell",
}
SAFE_NAME = re.compile(r"^[a-z][a-z0-9-]{2,63}$")


class LayoutError(ValueError):
    pass


def _string_list(component: Mapping[str, Any], field: str) -> list[str]:
    value = component.get(field)
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise LayoutError(f"{component.get('name', '<unknown>')}.{field} must be a string list")
    return value


def _check_cycle(dependencies: Mapping[str, list[str]]) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(name: str, trail: list[str]) -> None:
        if name in visiting:
            raise LayoutError("dependency cycle: " + " -> ".join([*trail, name]))
        if name in visited:
            return
        visiting.add(name)
        for dependency in dependencies.get(name, []):
            visit(dependency, [*trail, name])
        visiting.remove(name)
        visited.add(name)

    for component_name in dependencies:
        visit(component_name, [])


def validate_catalog(catalog: Mapping[str, Any], root: pathlib.Path = ROOT) -> dict[str, int]:
    if catalog.get("schemaVersion") != 1:
        raise LayoutError("schemaVersion must be 1")
    if not isinstance(catalog.get("platformVersion"), str):
        raise LayoutError("platformVersion must be a string")
    components = catalog.get("components")
    if not isinstance(components, list) or not components:
        raise LayoutError("components must be a non-empty list")

    names: set[str] = set()
    paths: set[str] = set()
    dependencies: dict[str, list[str]] = {}
    kinds: defaultdict[str, int] = defaultdict(int)
    for component in components:
        if not isinstance(component, Mapping):
            raise LayoutError("every component must be an object")
        name = component.get("name")
        relative = component.get("path")
        if not isinstance(name, str) or not SAFE_NAME.fullmatch(name):
            raise LayoutError(f"invalid component name: {name}")
        if name in names:
            raise LayoutError(f"duplicate component name: {name}")
        names.add(name)
        if not isinstance(relative, str):
            raise LayoutError(f"{name}.path must be a string")
        relative_path = pathlib.PurePosixPath(relative)
        if relative_path.is_absolute() or ".." in relative_path.parts or len(relative_path.parts) < 2:
            raise LayoutError(f"unsafe component path: {relative}")
        if relative in paths:
            raise LayoutError(f"duplicate component path: {relative}")
        paths.add(relative)
        component_path = root / relative_path
        if not component_path.is_dir():
            raise LayoutError(f"component directory is missing: {relative}")
        if not (component_path / "README.md").is_file():
            raise LayoutError(f"component README is missing: {relative}/README.md")
        kind = component.get("kind")
        runtime = component.get("runtime")
        if not isinstance(kind, str) or not kind or not isinstance(runtime, str) or not runtime:
            raise LayoutError(f"{name} must declare kind and runtime")
        kinds[kind] += 1
        owns = _string_list(component, "owns")
        if not owns:
            raise LayoutError(f"{name}.owns must not be empty")
        dependencies[name] = _string_list(component, "dependsOn")

    missing = REQUIRED_COMPONENTS - names
    if missing:
        raise LayoutError("required components missing: " + ", ".join(sorted(missing)))
    for name, component_dependencies in dependencies.items():
        for dependency in component_dependencies:
            if dependency == name:
                raise LayoutError(f"{name} cannot depend on itself")
            if dependency not in names:
                raise LayoutError(f"{name} has unknown dependency: {dependency}")
    _check_cycle(dependencies)
    return {"components": len(names), "kinds": len(kinds), "dependencyEdges": sum(map(len, dependencies.values()))}


def main() -> int:
    with CATALOG.open(encoding="utf-8") as stream:
        catalog = json.load(stream)
    summary = validate_catalog(catalog)
    print(
        "module layout valid: "
        f"{summary['components']} components, "
        f"{summary['kinds']} kinds, "
        f"{summary['dependencyEdges']} dependency edges"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
