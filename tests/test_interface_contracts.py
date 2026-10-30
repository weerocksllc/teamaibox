from __future__ import annotations

import copy
import json
import unittest

from tools.validate_interface_contracts import (
    CATALOG,
    CONTRACT_ROOT,
    POLICY,
    InterfaceContractError,
    assert_backward_compatible,
    validate,
)


class InterfaceContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = json.loads(POLICY.read_text(encoding="utf-8"))
        self.catalog = json.loads(CATALOG.read_text(encoding="utf-8"))

    def test_committed_interface_catalog_is_valid(self) -> None:
        summary = validate(self.policy, self.catalog)
        self.assertEqual(summary["families"], 8)
        self.assertEqual(summary["contracts"], 48)

    def test_user_activity_contract_is_owner_safe_and_has_explicit_wait_semantics(self) -> None:
        activity = json.loads(
            (CONTRACT_ROOT / "http" / "user-activity.v1.schema.json").read_text(encoding="utf-8")
        )
        self.assertEqual(activity["additionalProperties"], False)
        self.assertEqual(activity["$defs"]["task"]["additionalProperties"], False)
        self.assertIn("estimatedSeconds", activity["$defs"]["taskWait"]["required"])
        serialized = json.dumps(activity).lower()
        for forbidden in ("owneridentityid", "nodeid", "workerid", "prompt", "filename", "route", "endpoint"):
            self.assertNotIn(forbidden, serialized)

    def test_diagnostic_bundle_is_closed_and_keeps_sensitive_content_explicit(self) -> None:
        bundle = json.loads(
            (CONTRACT_ROOT / "http" / "diagnostic-bundle.v1.schema.json").read_text(encoding="utf-8")
        )
        self.assertEqual(bundle["additionalProperties"], False)
        self.assertEqual(bundle["$defs"]["signal"]["additionalProperties"], False)
        self.assertEqual(bundle["$defs"]["sensitiveItem"]["additionalProperties"], False)
        self.assertIn("sensitiveContentIncluded", bundle["required"])
        self.assertEqual(bundle["properties"]["sensitiveContent"]["maxItems"], 100)
        serialized = json.dumps(bundle).lower()
        for forbidden in ("authorization", "password", "privatekey", "accesstoken", "requestbody"):
            self.assertNotIn(forbidden, serialized)

    def test_audit_event_page_is_closed_signed_and_content_free(self) -> None:
        page = json.loads(
            (CONTRACT_ROOT / "http" / "audit-event-page.v1.schema.json").read_text(encoding="utf-8")
        )
        event = page["$defs"]["event"]
        self.assertEqual(page["additionalProperties"], False)
        self.assertEqual(event["additionalProperties"], False)
        self.assertEqual(event["properties"]["checkpoint"]["additionalProperties"], False)
        self.assertIn("previousEventHash", event["required"])
        self.assertIn("checkpoint", event["required"])
        serialized = json.dumps(page).lower()
        for forbidden in ("requestbody", "plaintext", "accesstoken", "privatekey"):
            self.assertNotIn(forbidden, serialized)

    def test_maintenance_administration_is_closed_and_hides_execution_material(self) -> None:
        schema = json.loads(
            (CONTRACT_ROOT / "http" / "maintenance-administration.v1.schema.json").read_text(encoding="utf-8")
        )
        self.assertEqual(schema["additionalProperties"], False)
        self.assertEqual(schema["$defs"]["candidate"]["additionalProperties"], False)
        self.assertIn("rollbackInstructions", schema["$defs"]["plan"]["required"])
        self.assertIn("secureBootCompatible", schema["$defs"]["preflight"]["required"])
        serialized = json.dumps(schema).lower()
        for forbidden in ("password", "secret", "credential", "privatekey", "command", "endpoint", "imagemanifest", "packages"):
            self.assertNotIn(forbidden, serialized)

    def test_managed_node_inventory_is_complete_and_has_no_secret_or_endpoint_fields(self) -> None:
        inventory = json.loads(
            (CONTRACT_ROOT / "node-agent" / "node-inventory.v1.schema.json").read_text(encoding="utf-8")
        )
        self.assertEqual(inventory["properties"]["architecture"]["const"], "arm64")
        self.assertEqual(inventory["additionalProperties"], False)
        for field in ("runtimes", "modelProfiles", "capabilities", "resources", "schedulerFacts", "networkLinks", "reservations", "activeWorkloads"):
            self.assertIn(field, inventory["required"])
        serialized = json.dumps(inventory).lower()
        for forbidden in ("password", "authorization", "privatekey", "credential", "endpointurl"):
            self.assertNotIn(forbidden, serialized)

    def test_managed_node_metrics_require_explicit_support_and_unified_memory_evidence(self) -> None:
        metrics = json.loads(
            (CONTRACT_ROOT / "node-agent" / "node-metrics.v1.schema.json").read_text(encoding="utf-8")
        )
        self.assertEqual(metrics["additionalProperties"], False)
        self.assertIn("dedicatedAcceleratorMemoryBytes", metrics["$defs"]["unifiedMemory"]["required"])
        self.assertEqual(metrics["$defs"]["metric"]["oneOf"][1]["properties"]["value"]["type"], "null")
        for section in ("processes", "workers", "models", "jobs", "queues", "reservations", "coreServices"):
            self.assertIn(section, metrics["required"])
        serialized = json.dumps(metrics).lower()
        for forbidden in ("password", "authorization", "credential", "prompt", "filename", "command"):
            self.assertNotIn(forbidden, serialized)

    def test_rejects_missing_family_coverage(self) -> None:
        catalog = copy.deepcopy(self.catalog)
        catalog["contracts"] = [item for item in catalog["contracts"] if item["family"] != "worker"]
        with self.assertRaisesRegex(InterfaceContractError, "each required"):
            validate(self.policy, catalog)

    def test_compute_domain_publishes_current_local_contracts(self) -> None:
        expected = {
            "compute-capability",
            "compute-model-profile",
            "compute-job",
            "compute-attempt",
            "compute-reservation",
            "compute-worker-instance",
            "compute-artifact-ref",
            "compute-provider-error",
        }
        compute = {
            entry["id"] for entry in self.catalog["contracts"]
            if entry["family"] == "compute"
        }
        self.assertEqual(compute, expected)

    def test_compute_profiles_pin_nvfp4_artifacts_runtime_limits_and_resource_envelope(self) -> None:
        profile = json.loads(
            (CONTRACT_ROOT / "compute" / "model-profile.v1.schema.json").read_text(encoding="utf-8")
        )
        self.assertIn("nvfp4", profile["properties"]["precision"]["enum"])
        self.assertIn("artifactDigest", profile["required"])
        self.assertIn("executionKind", profile["required"])
        self.assertIn("artifacts", profile["required"])
        self.assertIn("coldStart", profile["required"])
        self.assertIn("validationEvidence", profile["required"])
        self.assertIn("imageDigest", profile["$defs"]["engine"]["required"])
        self.assertIn("configurationDigest", profile["$defs"]["engine"]["required"])
        self.assertIn("reviewStatus", profile["$defs"]["source"]["properties"]["license"]["required"])
        self.assertIn("recipeDigest", profile["$defs"]["quantizationRecipe"]["required"])
        self.assertIn("apiContracts", profile["required"])
        self.assertIn("resourceEnvelope", profile["required"])
        lifecycle_states = profile["$defs"]["certification"]["properties"]["state"]["enum"]
        for state in ("experimental", "validating", "certified", "deprecated", "failed", "revalidation_required"):
            self.assertIn(state, lifecycle_states)
        resources = profile["$defs"]["resourceEnvelope"]["properties"]
        self.assertIn("accountingMode", resources)
        self.assertIn("unifiedMemoryBytes", resources)
        self.assertNotIn("dedicatedVramBytes", resources)
        self.assertNotIn("updatedAt", profile["properties"])

    def test_compute_attempt_and_provider_error_make_acceptance_and_replay_safety_explicit(self) -> None:
        attempt = json.loads(
            (CONTRACT_ROOT / "compute" / "attempt.v1.schema.json").read_text(encoding="utf-8")
        )
        provider = json.loads(
            (CONTRACT_ROOT / "compute" / "provider-error.v1.schema.json").read_text(encoding="utf-8")
        )
        self.assertIn("acceptanceState", attempt["required"])
        self.assertIn("retryClassification", attempt["required"])
        self.assertIn("side_effect_uncertain", provider["properties"]["acceptanceState"]["enum"])
        self.assertIn("unsafe_after_output", provider["properties"]["replaySafety"]["enum"])
        self.assertNotIn("rawResponse", provider["properties"])

    def test_compute_contracts_reference_objects_without_credentials_or_worker_addresses(self) -> None:
        artifact = json.loads(
            (CONTRACT_ROOT / "compute" / "artifact-ref.v1.schema.json").read_text(encoding="utf-8")
        )
        object_fields = artifact["properties"]["object"]["properties"]
        self.assertEqual(set(object_fields), {"objectId", "objectVersion", "referenceId"})
        reservation = json.loads(
            (CONTRACT_ROOT / "compute" / "reservation.v1.schema.json").read_text(encoding="utf-8")
        )
        self.assertIn("leaseId", reservation["required"])
        self.assertNotIn("leaseToken", reservation["properties"])
        worker = json.loads(
            (CONTRACT_ROOT / "compute" / "worker-instance.v1.schema.json").read_text(encoding="utf-8")
        )
        self.assertNotIn("containerAddress", worker["properties"])
        self.assertNotIn("containerId", worker["properties"])

    def test_rejects_shortened_public_deprecation_window(self) -> None:
        policy = copy.deepcopy(self.policy)
        policy["deprecation"]["stablePublicMinimumNoticeDays"] = 30
        with self.assertRaisesRegex(InterfaceContractError, "180 days"):
            validate(policy, self.catalog)

    def test_request_compatibility_accepts_optional_addition(self) -> None:
        previous = {
            "type": "object",
            "additionalProperties": False,
            "required": ["model"],
            "properties": {"model": {"type": "string"}},
        }
        current = copy.deepcopy(previous)
        current["properties"]["priority"] = {"type": "integer"}
        assert_backward_compatible(previous, current, "request")

    def test_request_compatibility_rejects_new_required_member(self) -> None:
        previous = {"type": "object", "required": ["model"], "properties": {"model": {"type": "string"}}}
        current = copy.deepcopy(previous)
        current["required"].append("priority")
        current["properties"]["priority"] = {"type": "integer"}
        with self.assertRaisesRegex(InterfaceContractError, "new required request"):
            assert_backward_compatible(previous, current, "request")

    def test_request_compatibility_rejects_narrowed_enum(self) -> None:
        previous = {"type": "string", "enum": ["local", "external"]}
        current = {"type": "string", "enum": ["local"]}
        with self.assertRaisesRegex(InterfaceContractError, "enum values"):
            assert_backward_compatible(previous, current, "request")

    def test_response_compatibility_rejects_removed_guarantee(self) -> None:
        previous = {"type": "object", "required": ["job_id"], "properties": {"job_id": {"type": "string"}}}
        current = {"type": "object", "required": [], "properties": {"job_id": {"type": "string"}}}
        with self.assertRaisesRegex(InterfaceContractError, "response guarantees"):
            assert_backward_compatible(previous, current, "response")

    def test_response_compatibility_rejects_expanded_enum_without_extension_point(self) -> None:
        previous = {"type": "string", "enum": ["queued", "running"]}
        current = {"type": "string", "enum": ["queued", "running", "paused"]}
        with self.assertRaisesRegex(InterfaceContractError, "new output enum"):
            assert_backward_compatible(previous, current, "response")


if __name__ == "__main__":
    unittest.main()
