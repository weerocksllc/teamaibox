from __future__ import annotations

import datetime as dt
import unittest

from tools.lab_maintenance_guard import PlanError, validate_plan


NOW = dt.datetime(2026, 8, 10, 8, 0, tzinfo=dt.timezone.utc)


def valid_plan() -> dict[str, object]:
    return {
        "schema_version": "1.0",
        "plan_id": "maint-2026-001",
        "target": "dgx-spark-dev-01",
        "operation": "luks-conversion",
        "status": "approved",
        "owner": "maintainer",
        "reason": "exercise guarded conversion",
        "maintenance_window": {
            "starts_at": "2026-08-10T07:30:00Z",
            "ends_at": "2026-08-10T08:30:00Z",
        },
        "data_risk_acknowledged": True,
        "backup_or_recovery": "verified recovery image and restore procedure",
        "out_of_band_access": "local console and recovery media",
        "prechecks": ["verify backup", "record device map"],
        "implementation_steps": ["run the separately reviewed procedure"],
        "validation_steps": ["verify boot and protected storage"],
        "rollback_triggers": ["unexpected device map"],
        "rollback_steps": ["stop and restore the verified image"],
        "evidence_destination": "evidence/maintenance/maint-2026-001",
        "approvals": [
            {
                "approved_by": "lab-owner",
                "role": "lab-owner",
                "approved_at": "2026-08-10T07:45:00Z",
            }
        ],
    }


class LabMaintenanceGuardTests(unittest.TestCase):
    def test_accepts_complete_plan_in_window(self) -> None:
        receipt = validate_plan(valid_plan(), "luks-conversion", now=NOW)
        self.assertEqual(receipt["plan_id"], "maint-2026-001")
        self.assertEqual(receipt["operation"], "luks-conversion")

    def test_rejects_draft(self) -> None:
        plan = valid_plan()
        plan["status"] = "draft"
        with self.assertRaisesRegex(PlanError, "status"):
            validate_plan(plan, "luks-conversion", now=NOW)

    def test_rejects_operation_mismatch(self) -> None:
        with self.assertRaisesRegex(PlanError, "does not match"):
            validate_plan(valid_plan(), "nvidia-driver-change", now=NOW)

    def test_rejects_outside_window(self) -> None:
        later = NOW + dt.timedelta(hours=2)
        with self.assertRaisesRegex(PlanError, "outside"):
            validate_plan(valid_plan(), "luks-conversion", now=later)

    def test_rejects_missing_recovery_or_rollback(self) -> None:
        for field, replacement in (("backup_or_recovery", ""), ("rollback_steps", [])):
            plan = valid_plan()
            plan[field] = replacement
            with self.subTest(field=field), self.assertRaises(PlanError):
                validate_plan(plan, "luks-conversion", now=NOW)


if __name__ == "__main__":
    unittest.main()

