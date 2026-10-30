#!/usr/bin/env python3
"""Validate interface catalog policy and direction-aware JSON compatibility."""

from __future__ import annotations

import json
import pathlib
import re
from typing import Any, Mapping


ROOT = pathlib.Path(__file__).resolve().parents[1]
CONTRACT_ROOT = ROOT / "packages" / "contracts"
POLICY = CONTRACT_ROOT / "interface-families.v1.json"
CATALOG = CONTRACT_ROOT / "catalog.v1.json"
REQUIRED_FAMILIES = {
    "http",
    "openai",
    "realtime",
    "node-agent",
    "worker",
    "plugin",
    "object",
    "compute",
}
IDENTIFIER = re.compile(r"^[a-z][a-z0-9-]{2,63}$")
SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$")


class InterfaceContractError(ValueError):
    pass


def _type_set(schema: Mapping[str, Any]) -> set[str] | None:
    value = schema.get("type")
    if value is None:
        if "const" in schema:
            constant = schema["const"]
            if constant is None:
                return {"null"}
            if isinstance(constant, bool):
                return {"boolean"}
            if isinstance(constant, int):
                return {"integer"}
            if isinstance(constant, float):
                return {"number"}
            if isinstance(constant, str):
                return {"string"}
        return None
    if isinstance(value, str):
        return {value}
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return set(value)
    raise InterfaceContractError("schema type must be a string or string list")


def _assert_type_compatible(previous: Mapping[str, Any], current: Mapping[str, Any], role: str, path: str) -> None:
    old_types = _type_set(previous)
    new_types = _type_set(current)
    if old_types is None:
        if role == "request" and new_types is not None:
            raise InterfaceContractError(f"{path}: input type was narrowed")
        return
    if new_types is None:
        if role == "response":
            raise InterfaceContractError(f"{path}: output type guarantee was removed")
        return
    if role == "request" and not old_types.issubset(new_types):
        raise InterfaceContractError(f"{path}: accepted input types were narrowed")
    if role == "response" and not new_types.issubset(old_types):
        raise InterfaceContractError(f"{path}: produced output types were widened")


def _assert_value_constraints(previous: Mapping[str, Any], current: Mapping[str, Any], role: str, path: str) -> None:
    old_enum = previous.get("enum")
    new_enum = current.get("enum")
    if isinstance(old_enum, list):
        if not isinstance(new_enum, list):
            if role == "response":
                raise InterfaceContractError(f"{path}: output enum guarantee was removed")
        elif role == "request" and not set(old_enum).issubset(new_enum):
            raise InterfaceContractError(f"{path}: accepted enum values were removed")
        elif role == "response" and not set(new_enum).issubset(old_enum):
            raise InterfaceContractError(f"{path}: new output enum values require an extension point or major")
    if "const" in previous:
        if "const" not in current:
            if role == "response":
                raise InterfaceContractError(f"{path}: output constant guarantee was removed")
        elif previous["const"] != current["const"]:
            raise InterfaceContractError(f"{path}: constant value changed")

    for lower in ("minimum", "minLength", "minItems"):
        if lower in previous and lower in current:
            if role == "request" and current[lower] > previous[lower]:
                raise InterfaceContractError(f"{path}: accepted lower bound was narrowed")
            if role == "response" and current[lower] < previous[lower]:
                raise InterfaceContractError(f"{path}: output lower-bound guarantee was weakened")
    for upper in ("maximum", "maxLength", "maxItems"):
        if upper in previous and upper in current:
            if role == "request" and current[upper] < previous[upper]:
                raise InterfaceContractError(f"{path}: accepted upper bound was narrowed")
            if role == "response" and current[upper] > previous[upper]:
                raise InterfaceContractError(f"{path}: output upper-bound guarantee was weakened")
    if previous.get("pattern") != current.get("pattern"):
        if role == "request" and "pattern" in current:
            raise InterfaceContractError(f"{path}: input pattern changed or was added")
        if role == "response" and "pattern" in previous:
            raise InterfaceContractError(f"{path}: output pattern changed or was removed")
    if previous.get("format") != current.get("format"):
        if role == "request" and "format" in current:
            raise InterfaceContractError(f"{path}: input format changed or was added")
        if role == "response" and "format" in previous:
            raise InterfaceContractError(f"{path}: output format changed or was removed")
    if role == "request" and previous.get("uniqueItems") is not True and current.get("uniqueItems") is True:
        raise InterfaceContractError(f"{path}: unique input items are newly required")
    if role == "response" and previous.get("uniqueItems") is True and current.get("uniqueItems") is not True:
        raise InterfaceContractError(f"{path}: unique output item guarantee was removed")


def assert_backward_compatible(
    previous: Mapping[str, Any],
    current: Mapping[str, Any],
    role: str,
    path: str = "$",
) -> None:
    """Raise when current cannot replace previous within the same major."""

    if role == "bidirectional":
        assert_backward_compatible(previous, current, "request", path)
        assert_backward_compatible(previous, current, "response", path)
        return
    if role not in {"request", "response"}:
        raise InterfaceContractError("compatibility role is invalid: " + role)
    _assert_type_compatible(previous, current, role, path)
    _assert_value_constraints(previous, current, role, path)

    old_required = set(previous.get("required", []))
    new_required = set(current.get("required", []))
    if role == "request" and not new_required.issubset(old_required):
        raise InterfaceContractError(f"{path}: new required request members were added")
    if role == "response" and not old_required.issubset(new_required):
        raise InterfaceContractError(f"{path}: required response guarantees were removed")

    old_properties = previous.get("properties", {})
    new_properties = current.get("properties", {})
    if isinstance(old_properties, Mapping) and isinstance(new_properties, Mapping):
        for name, old_child in old_properties.items():
            if name not in new_properties:
                if role == "response" and name not in old_required:
                    continue
                if role == "request" and current.get("additionalProperties", True) is not False:
                    continue
                raise InterfaceContractError(f"{path}.{name}: contract member was removed")
            if isinstance(old_child, Mapping) and isinstance(new_properties[name], Mapping):
                assert_backward_compatible(old_child, new_properties[name], role, f"{path}.{name}")
        if role == "request" and previous.get("additionalProperties", True) is not False and current.get("additionalProperties") is False:
            raise InterfaceContractError(f"{path}: unknown request members are no longer accepted")

    old_items = previous.get("items")
    new_items = current.get("items")
    if isinstance(old_items, Mapping) and isinstance(new_items, Mapping):
        assert_backward_compatible(old_items, new_items, role, path + "[]")


def validate(policy: Mapping[str, Any], catalog: Mapping[str, Any], root: pathlib.Path = CONTRACT_ROOT) -> dict[str, int]:
    if policy.get("policyVersion") != 1 or not SEMVER.fullmatch(str(policy.get("platformVersion", ""))):
        raise InterfaceContractError("interface policy version or platform SemVer is invalid")
    deprecation = policy.get("deprecation")
    if not isinstance(deprecation, Mapping):
        raise InterfaceContractError("deprecation policy is required")
    if deprecation.get("stablePublicMinimumNoticeDays", 0) < 180:
        raise InterfaceContractError("stable public deprecation notice must be at least 180 days")
    if deprecation.get("managedInternalMinimumNoticeDays", 0) < 90:
        raise InterfaceContractError("managed internal deprecation notice must be at least 90 days")
    if set(deprecation.get("httpHeaders", [])) != {"Deprecation", "Sunset", "Link"}:
        raise InterfaceContractError("deprecation HTTP headers are incomplete")
    required_deprecation_fields = set(deprecation.get("requiredFields", []))
    if len(required_deprecation_fields) < 6:
        raise InterfaceContractError("deprecation records do not require sufficient evidence")

    families = policy.get("families")
    if not isinstance(families, list):
        raise InterfaceContractError("interface families must be a list")
    family_by_id: dict[str, Mapping[str, Any]] = {}
    for family in families:
        if not isinstance(family, Mapping) or not IDENTIFIER.fullmatch(str(family.get("id", ""))):
            raise InterfaceContractError("interface family identifier is invalid")
        identifier = str(family["id"])
        if identifier in family_by_id:
            raise InterfaceContractError("interface family is duplicated: " + identifier)
        if family.get("currentMajor") != 1 or "1" not in str(family.get("versionPlacement", "")):
            raise InterfaceContractError(identifier + " must expose its current major")
        for field in ("audience", "transport", "negotiation", "compatibility"):
            if not isinstance(family.get(field), str) or not family[field]:
                raise InterfaceContractError(identifier + " is missing " + field)
        family_by_id[identifier] = family
    if not REQUIRED_FAMILIES.issubset(family_by_id):
        raise InterfaceContractError("required interface families are missing")

    if catalog.get("catalogVersion") != 1 or not isinstance(catalog.get("contracts"), list):
        raise InterfaceContractError("contract catalog version is invalid")
    ids: set[str] = set()
    paths: set[str] = set()
    covered: set[str] = set()
    for entry in catalog["contracts"]:
        if not isinstance(entry, Mapping):
            raise InterfaceContractError("contract catalog entry must be an object")
        identifier = str(entry.get("id", ""))
        family = str(entry.get("family", ""))
        role = entry.get("role")
        relative = entry.get("path")
        if not IDENTIFIER.fullmatch(identifier) or identifier in ids:
            raise InterfaceContractError("contract identifier is invalid or duplicated: " + identifier)
        if family not in family_by_id:
            raise InterfaceContractError(identifier + " uses an unknown family")
        if entry.get("major") != family_by_id[family]["currentMajor"]:
            raise InterfaceContractError(identifier + " major does not match its family")
        if role not in {"request", "response", "bidirectional"}:
            raise InterfaceContractError(identifier + " role is invalid")
        if entry.get("stability") not in {"experimental", "stable", "deprecated"}:
            raise InterfaceContractError(identifier + " stability is invalid")
        if not isinstance(relative, str):
            raise InterfaceContractError(identifier + " path is invalid")
        relative_path = pathlib.PurePosixPath(relative)
        if relative_path.is_absolute() or ".." in relative_path.parts or relative in paths:
            raise InterfaceContractError(identifier + " path is unsafe or duplicated")
        if not relative.endswith(f".v{entry['major']}.schema.json"):
            raise InterfaceContractError(identifier + " filename does not carry its major")
        schema_path = root / relative_path
        if not schema_path.is_file():
            raise InterfaceContractError(identifier + " schema is missing")
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
            raise InterfaceContractError(identifier + " must use JSON Schema 2020-12")
        if not str(schema.get("$id", "")).endswith("/" + relative):
            raise InterfaceContractError(identifier + " schema ID does not match its path")
        metadata = schema.get("x-teamaibox-contract")
        expected = {"family": family, "role": role, "major": entry["major"]}
        if metadata != expected:
            raise InterfaceContractError(identifier + " contract metadata does not match its catalog entry")
        if schema.get("type") != "object" or not isinstance(schema.get("required"), list) or not isinstance(schema.get("properties"), Mapping):
            raise InterfaceContractError(identifier + " must be a concrete object schema")
        if entry.get("stability") == "deprecated":
            record = entry.get("deprecation")
            if not isinstance(record, Mapping) or not required_deprecation_fields.issubset(record):
                raise InterfaceContractError(identifier + " has incomplete deprecation evidence")
        ids.add(identifier)
        paths.add(relative)
        covered.add(family)
    if not REQUIRED_FAMILIES.issubset(covered):
        raise InterfaceContractError("each required interface family needs a cataloged contract")
    return {"families": len(family_by_id), "contracts": len(ids), "stable": sum(item.get("stability") == "stable" for item in catalog["contracts"])}


def main() -> int:
    policy = json.loads(POLICY.read_text(encoding="utf-8"))
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    summary = validate(policy, catalog)
    print(
        "interface contracts valid: "
        f"{summary['families']} families, {summary['contracts']} contracts, "
        f"{summary['stable']} stable"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
