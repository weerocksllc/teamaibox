import unittest
from pathlib import Path

from tools.validate_model_coexistence_evidence import (
    CORE_OPERATION_EVIDENCE,
    assert_no_retained_text,
    expected_core_container_names,
    require_exact_mapping_keys,
    validate_core_container_boundaries,
    validate_drain,
    validate_run_identity,
)


class ModelCoexistenceEvidenceTests(unittest.TestCase):
    def test_mapping_coverage_is_exact_but_not_serialization_order_dependent(self):
        value = {"queue": {}, "identity": {}}
        self.assertIs(require_exact_mapping_keys(value, ["identity", "queue"], "coverage"), value)
        with self.assertRaisesRegex(ValueError, "coverage"):
            require_exact_mapping_keys({"identity": {}}, ["identity", "queue"], "coverage")
        with self.assertRaisesRegex(ValueError, "coverage"):
            require_exact_mapping_keys({"identity": {}, "queue": {}, "extra": {}}, ["identity", "queue"], "coverage")

    def test_content_safe_evidence_allows_digests_and_rejects_payload_text(self):
        assert_no_retained_text({"responseDigest": "sha256:" + "0" * 64, "completed": 1})
        with self.assertRaisesRegex(ValueError, "retains request or response text"):
            assert_no_retained_text({"prompt": "sensitive"})
        with self.assertRaisesRegex(ValueError, "retains request or response text"):
            assert_no_retained_text({"nested": [{"output": "sensitive"}]})

    def test_drain_requires_exact_ordered_run_scoped_container_identities(self):
        item = {
            "container": "teamaibox-coexist-run-worker-ocr", "beforeRunning": True,
            "afterRunning": False, "exitCode": 0, "oomKilled": False,
        }
        validate_drain([item], [item["container"]], "shared")
        with self.assertRaisesRegex(ValueError, "coverage drifted"):
            validate_drain([item], ["teamaibox-coexist-run-worker-asr"], "shared")

    def test_core_container_identity_is_exact_ordered_and_run_scoped(self):
        self.assertEqual(expected_core_container_names("coexist-20260812-a1"), [
            "teamaibox-coexist-coexist-20260812-a1-core-platform",
            "teamaibox-coexist-coexist-20260812-a1-core-web",
            "teamaibox-coexist-coexist-20260812-a1-core-object",
            "teamaibox-coexist-coexist-20260812-a1-core-messaging",
            "teamaibox-coexist-coexist-20260812-a1-core-scheduler",
            "teamaibox-coexist-coexist-20260812-a1-core-postgres",
            "teamaibox-coexist-coexist-20260812-a1-core-queue",
        ])

    def test_report_run_identity_must_match_its_evidence_path(self):
        path = Path("evidence/validation/models/coexist-20260812-a1.json")
        self.assertEqual(validate_run_identity("coexist-20260812-a1", path), "coexist-20260812-a1")
        with self.assertRaisesRegex(ValueError, "identity or evidence path drifted"):
            validate_run_identity("coexist-20260812-a2", path)
        with self.assertRaisesRegex(ValueError, "identity or evidence path drifted"):
            validate_run_identity("../unsafe", path)

    def test_core_operation_evidence_marks_required_domains_as_functional(self):
        for domain in ("identity", "administration", "files", "messaging", "object"):
            self.assertTrue(CORE_OPERATION_EVIDENCE[domain].startswith("functional-"))

    def test_core_container_boundaries_bind_exact_ids_and_reject_substitution(self):
        run_id = "coexist-20260812-a1"
        suffixes = (
            "core-platform", "core-web", "core-object", "core-messaging",
            "core-scheduler", "core-postgres", "core-queue",
        )
        items = [{
            "container": name, "containerId": f"{ordinal:064x}", "role": suffix,
            "owner": "model-coexistence-validation", "runId": run_id,
            "running": True, "oomKilled": False, "restarting": False,
            "networkMode": f"teamaibox-coexist-net-{run_id}", "restartPolicy": "no",
        } for ordinal, (name, suffix) in enumerate(
            zip(expected_core_container_names(run_id), suffixes), start=1,
        )]
        self.assertEqual(validate_core_container_boundaries(items, run_id), items)
        substituted = [dict(item) for item in items]
        substituted[1]["containerId"] = substituted[0]["containerId"]
        with self.assertRaisesRegex(ValueError, "not unique"):
            validate_core_container_boundaries(substituted, run_id)


if __name__ == "__main__":
    unittest.main()
