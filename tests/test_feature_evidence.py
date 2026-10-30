from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import unittest

from tools.validate_feature_evidence import (
    CATALOG,
    MIGRATIONS,
    FeatureEvidenceError,
    canonical_digest,
    digest_bytes,
    validate_evidence,
    validate_schema,
)


SHA_A = "sha256:" + "a" * 64


class FeatureEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
        self.feature = next(item for item in self.catalog["features"] if item["key"] == "official.messaging")

    def reference(self, root: Path, name: str, payload: bytes | None = None) -> dict[str, str]:
        path = Path("evidence") / name
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload if payload is not None else (name + "\n").encode())
        return {"path": path.as_posix(), "digest": digest_bytes(target.read_bytes())}

    def valid(self, root: Path) -> dict:
        artifact = self.reference(root, "feature-tests/artifact.json")
        value = {
            "schemaVersion": 1,
            "evidenceId": "feature-official.messaging-20260812-a1",
            "featureKey": "official.messaging",
            "catalogDigest": canonical_digest(self.catalog),
            "runId": "messaging-20260812-a1",
            "status": "passed",
            "startedAt": "2026-08-12T01:00:00Z",
            "completedAt": "2026-08-12T01:30:00Z",
            "source": {
                "revision": "b" * 40,
                "treeDigest": SHA_A,
                "dirty": False,
                "artifacts": [artifact],
            },
            "deployment": {
                "deploymentId": "messaging-20260812-a1",
                "targetNodeId": "dgx-spark-dev-01",
                "architecture": "linux/arm64/v8",
                "composeProject": "teamaibox_messaging_a1",
                "ociImages": [{
                    "component": "messaging",
                    "reference": "registry.example/teamaibox/messaging@" + SHA_A,
                    "digest": SHA_A,
                    "platform": "linux/arm64/v8",
                }],
                "configurationDigest": SHA_A,
                "idempotentReplayPassed": True,
            },
            "sparkInventory": {
                "nodeId": "dgx-spark-dev-01",
                "architecture": "linux/arm64/v8",
                "inventoryDigest": SHA_A,
                "capturedAt": "2026-08-12T00:45:00Z",
                "hardwareGates": [],
            },
            "configuration": {
                "schemaVersion": 54,
                "migrationManifestDigest": digest_bytes(MIGRATIONS.read_bytes()),
                "appliedMigrations": self.feature["migrations"],
                "persistentDependencies": self.feature["persistence"],
                "secretsRetained": False,
            },
            "health": {"passed": True, "checks": [{"key": "messaging-ready", "passed": True, "evidence": artifact}]},
            "journeys": {
                "success": {
                    "journeyId": self.feature["successJourney"], "runner": "real-browser", "authenticated": True,
                    "realEndpoint": True, "passed": True, "evidence": artifact,
                },
                "failure": {
                    "journeyId": self.feature["failureJourney"], "runner": "real-browser", "authenticated": True,
                    "realEndpoint": True, "passed": True, "evidence": artifact,
                },
            },
            "restart": {"passed": True, "checks": [{"key": "service-restart", "passed": True, "evidence": artifact}]},
            "rollback": {"passed": True, "checks": [{"key": "exact-rollback", "passed": True, "evidence": artifact}]},
            "residualState": {"passed": True, "ownedResources": ["volume:messages"], "unexpectedResources": []},
            "limitations": [],
            "humanGates": [],
            "successfulParent": None,
            "privacy": {
                "credentialsRetained": False, "userContentRetained": False,
                "commandOutputRetained": False, "redactionPassed": True,
            },
        }
        value["evidenceDigest"] = canonical_digest(value)
        return value

    @staticmethod
    def redigest(value: dict) -> dict:
        value["evidenceDigest"] = canonical_digest({key: item for key, item in value.items() if key != "evidenceDigest"})
        return value

    def test_schema_is_closed_and_complete(self) -> None:
        schema = validate_schema()
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(len(schema["required"]), 22)

    def test_complete_digest_pinned_feature_evidence_passes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = validate_evidence(self.valid(root), evidence_root=root)
            self.assertTrue(result["valid"])
            self.assertEqual(result["featureKey"], "official.messaging")
            self.assertFalse(result["successfulParentBound"])

    def test_catalog_source_and_oci_bindings_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mutations = []
            catalog = self.valid(root)
            catalog["catalogDigest"] = SHA_A
            mutations.append((catalog, "catalog digest"))
            dirty = self.valid(root)
            dirty["source"]["dirty"] = True
            mutations.append((dirty, "dirty source"))
            mutable = self.valid(root)
            mutable["deployment"]["ociImages"][0]["reference"] = "registry.example/teamaibox/messaging:latest"
            mutations.append((mutable, "not pinned"))
            for value, message in mutations:
                with self.subTest(message=message), self.assertRaisesRegex(FeatureEvidenceError, message):
                    validate_evidence(self.redigest(value), evidence_root=root)

    def test_migration_persistence_and_real_journey_bindings_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            migrations = self.valid(root)
            migrations["configuration"]["appliedMigrations"] = ["messaging"]
            with self.assertRaisesRegex(FeatureEvidenceError, "applied migrations"):
                validate_evidence(self.redigest(migrations), evidence_root=root)

            memory = self.valid(root)
            memory["configuration"]["persistentDependencies"] = ["in-memory:messages"]
            with self.assertRaisesRegex(FeatureEvidenceError, "persistent dependencies"):
                validate_evidence(self.redigest(memory), evidence_root=root)

            synthetic = self.valid(root)
            synthetic["journeys"]["success"]["realEndpoint"] = False
            with self.assertRaisesRegex(FeatureEvidenceError, "synthetic endpoint"):
                validate_evidence(self.redigest(synthetic), evidence_root=root)

    def test_restart_residual_inventory_privacy_and_canonical_digest_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            restart = self.valid(root)
            restart["restart"]["checks"][0]["passed"] = False
            restart["restart"]["passed"] = False
            with self.assertRaisesRegex(FeatureEvidenceError, "failed acceptance section"):
                validate_evidence(self.redigest(restart), evidence_root=root)

            residual = self.valid(root)
            residual["residualState"]["unexpectedResources"] = ["container:orphan"]
            with self.assertRaisesRegex(FeatureEvidenceError, "unexpected residual"):
                validate_evidence(self.redigest(residual), evidence_root=root)

            stale = self.valid(root)
            stale["sparkInventory"]["capturedAt"] = "2026-08-10T00:00:00Z"
            with self.assertRaisesRegex(FeatureEvidenceError, "stale"):
                validate_evidence(self.redigest(stale), evidence_root=root)

            privacy = self.valid(root)
            privacy["privacy"]["credentialsRetained"] = True
            with self.assertRaisesRegex(FeatureEvidenceError, "privacy"):
                validate_evidence(self.redigest(privacy), evidence_root=root)

            digest = self.valid(root)
            digest["runId"] = "messaging-20260812-tampered"
            with self.assertRaisesRegex(FeatureEvidenceError, "canonical digest"):
                validate_evidence(digest, evidence_root=root)

    def test_exact_successful_parent_is_verified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parent = {
                "featureKey": "official.messaging",
                "status": "passed",
                "completedAt": "2026-08-12T00:30:00Z",
            }
            parent["evidenceDigest"] = canonical_digest(parent)
            parent_reference = self.reference(
                root, "feature-tests/parent.json", json.dumps(parent, sort_keys=True, separators=(",", ":")).encode(),
            )
            value = self.valid(root)
            value["successfulParent"] = parent_reference
            result = validate_evidence(self.redigest(value), evidence_root=root)
            self.assertTrue(result["successfulParentBound"])

            wrong = self.valid(root)
            wrong["successfulParent"] = {**parent_reference, "digest": SHA_A}
            with self.assertRaisesRegex(FeatureEvidenceError, "digest does not match"):
                validate_evidence(self.redigest(wrong), evidence_root=root)


if __name__ == "__main__":
    unittest.main()
