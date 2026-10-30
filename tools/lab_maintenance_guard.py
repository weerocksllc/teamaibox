#!/usr/bin/env python3
"""Validate an approved maintenance plan for protected lab operations.

This guard never executes the requested operation. It emits a plan digest and
bounded authorization receipt that a future maintenance command must validate
immediately before making a protected change.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib
import re
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = "1.0"
PROTECTED_OPERATIONS = (
    "root-disk-repartition",
    "luks-conversion",
    "secure-boot-change",
    "platform-firmware-change",
    "nvidia-driver-change",
    "connectx-roce-reconfiguration",
)
_SAFE_IDENTIFIER = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,127}$")
_REQUIRED_NONEMPTY_LISTS = (
    "prechecks",
    "implementation_steps",
    "validation_steps",
    "rollback_triggers",
    "rollback_steps",
)


class PlanError(ValueError):
    pass


def _parse_time(value: Any, field: str) -> dt.datetime:
    if not isinstance(value, str):
        raise PlanError(f"{field} must be an RFC3339 string")
    normalized = value.replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(normalized)
    except ValueError as error:
        raise PlanError(f"{field} must be an RFC3339 timestamp") from error
    if parsed.tzinfo is None:
        raise PlanError(f"{field} must include a timezone")
    return parsed


def _nonempty_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PlanError(f"{field} must be non-empty text")
    return value.strip()


def _validate_string_list(plan: Mapping[str, Any], field: str) -> None:
    value = plan.get(field)
    if not isinstance(value, list) or not value:
        raise PlanError(f"{field} must be a non-empty list")
    for index, item in enumerate(value):
        _nonempty_text(item, f"{field}[{index}]")


def validate_plan(plan: Mapping[str, Any], requested_operation: str, now: dt.datetime | None = None) -> dict[str, Any]:
    if plan.get("schema_version") != SCHEMA_VERSION:
        raise PlanError(f"schema_version must be {SCHEMA_VERSION}")
    plan_id = _nonempty_text(plan.get("plan_id"), "plan_id")
    target = _nonempty_text(plan.get("target"), "target")
    if not _SAFE_IDENTIFIER.fullmatch(plan_id) or not _SAFE_IDENTIFIER.fullmatch(target):
        raise PlanError("plan_id and target must be stable non-secret identifiers")
    if requested_operation not in PROTECTED_OPERATIONS:
        raise PlanError("requested operation is not a recognized protected operation")
    if plan.get("operation") != requested_operation:
        raise PlanError("plan operation does not match the requested operation")
    if plan.get("status") != "approved":
        raise PlanError("maintenance plan status must be approved")
    if plan.get("data_risk_acknowledged") is not True:
        raise PlanError("data_risk_acknowledged must be true")

    _nonempty_text(plan.get("owner"), "owner")
    _nonempty_text(plan.get("reason"), "reason")
    _nonempty_text(plan.get("backup_or_recovery"), "backup_or_recovery")
    _nonempty_text(plan.get("out_of_band_access"), "out_of_band_access")
    _nonempty_text(plan.get("evidence_destination"), "evidence_destination")
    for field in _REQUIRED_NONEMPTY_LISTS:
        _validate_string_list(plan, field)

    window = plan.get("maintenance_window")
    if not isinstance(window, Mapping):
        raise PlanError("maintenance_window must be an object")
    starts_at = _parse_time(window.get("starts_at"), "maintenance_window.starts_at")
    ends_at = _parse_time(window.get("ends_at"), "maintenance_window.ends_at")
    if ends_at <= starts_at:
        raise PlanError("maintenance window end must be after its start")
    if ends_at - starts_at > dt.timedelta(hours=24):
        raise PlanError("maintenance window must not exceed 24 hours")

    approvals = plan.get("approvals")
    if not isinstance(approvals, list) or not approvals:
        raise PlanError("at least one explicit maintenance approval is required")
    for index, approval in enumerate(approvals):
        if not isinstance(approval, Mapping):
            raise PlanError(f"approvals[{index}] must be an object")
        _nonempty_text(approval.get("approved_by"), f"approvals[{index}].approved_by")
        _nonempty_text(approval.get("role"), f"approvals[{index}].role")
        approved_at = _parse_time(approval.get("approved_at"), f"approvals[{index}].approved_at")
        if approved_at > ends_at:
            raise PlanError(f"approvals[{index}] occurs after the maintenance window")

    current = now or dt.datetime.now(dt.timezone.utc)
    current = current.astimezone(dt.timezone.utc)
    if not (starts_at.astimezone(dt.timezone.utc) <= current <= ends_at.astimezone(dt.timezone.utc)):
        raise PlanError("current time is outside the approved maintenance window")

    return {
        "plan_id": plan_id,
        "target": target,
        "operation": requested_operation,
        "valid_until": ends_at.astimezone(dt.timezone.utc).isoformat(),
    }


def load_plan(path: pathlib.Path) -> tuple[dict[str, Any], str]:
    if path.is_symlink():
        raise PlanError("maintenance plan must not be a symbolic link")
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise PlanError("maintenance plan cannot be read") from error
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise PlanError("maintenance plan is not valid JSON") from error
    if not isinstance(value, dict):
        raise PlanError("maintenance plan must be a JSON object")
    return value, hashlib.sha256(raw).hexdigest()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operation", required=True, choices=PROTECTED_OPERATIONS)
    parser.add_argument("--plan", required=True, type=pathlib.Path)
    args = parser.parse_args(argv)
    try:
        plan, digest = load_plan(args.plan)
        receipt = validate_plan(plan, args.operation)
    except PlanError as error:
        parser.error(str(error))
    receipt["plan_sha256"] = digest
    receipt["authorized"] = True
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

