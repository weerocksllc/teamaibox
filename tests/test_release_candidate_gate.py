from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from tools.run_release_candidate_gate import CATALOG, ReleaseGateError, digest_bytes, validate_catalog, validate_manifest_and_evidence
from tools.validate_appliance_browser_acceptance import canonical_digest as browser_digest, validate as validate_browser
from tests.test_appliance_browser_acceptance import valid_report


SHA = "sha256:" + "a" * 64
REV = "b" * 40


class ReleaseCandidateGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog = json.loads(Path(CATALOG).read_text(encoding="utf-8"))
        self.now = datetime.now(timezone.utc).replace(microsecond=0)

    def source(self, root: Path, name: str) -> dict:
        path = root / name
        path.write_bytes((name + "\n").encode())
        return {"path": name, "digest": digest_bytes(path.read_bytes())}

    def envelope(self, root: Path, evidence_class: str, claims: dict, source: dict | None = None) -> dict:
        source = source or self.source(root, f"source-{evidence_class}.json")
        return {
            "schemaVersion": 1, "evidenceClass": evidence_class, "releaseCandidateId": "rc-test-1",
            "releaseDigest": SHA, "sourceRevision": REV, "sourceTreeDigest": SHA,
            "environmentDigest": SHA, "status": "passed",
            "startedAt": (self.now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
            "completedAt": (self.now - timedelta(minutes=1)).isoformat().replace("+00:00", "Z"),
            "expiresAt": (self.now + timedelta(days=1)).isoformat().replace("+00:00", "Z"),
            "claims": claims, "sourceEvidence": [source], "commandOutputRetained": False,
        }

    def complete_manifest(self, root: Path) -> dict:
        claims = {
            "real_spark_smoke": {"claimEligible": True, "cleanupPassed": True, "residualStatePassed": True, "currentHardware": True, "containerizedAppliance": True, "architecture": "linux/arm64/v8"},
            "certified_model": {"productionRoutingEligible": True, "conformancePassed": True, "qualityPassed": True, "resourceEnvelopePassed": True, "faultsPassed": True, "profileId": "profile.llm.nvfp4", "lifecycleState": "Certified", "modelEvidenceDigest": SHA},
            "model_soak": {"memoryPassed": True, "thermalPassed": True, "throughputPassed": True, "zeroCrashes": True, "zeroLostJobs": True, "zeroDuplicateJobs": True, "profileId": "profile.llm.nvfp4", "riskClass": "nvfp4", "selectedDurationHours": 24, "completedDurationSeconds": 86400, "smoke": False},
            "backup_restore": {"independentTarget": True, "integrityPassed": True, "disposableRestorePassed": True, "rpoPassed": True, "rtoPassed": True, "backupSetId": "backup-1", "restoreRunId": "restore-1"},
            "security": {"closedGatePassed": True, "dependencyPassed": True, "imagePassed": True, "secretPassed": True, "authorizationPassed": True, "isolationPassed": True, "recoveryMaterialPassed": True, "failedGateCount": 0},
            "upgrade_rollback": {"upgradePassed": True, "rollbackRehearsalPassed": True, "postRollbackHealthPassed": True, "dataIntegrityPassed": True, "modelRevalidationPassed": True, "previousReleaseDigest": SHA},
            "appliance_acceptance": {
                "releaseEvidenceEligible": True, "supportedContainerizedAppliance": True,
                "hostAllowlistConforming": True, "currentSparkHardwareCheckpoints": True,
                "authenticatedHttpsJourneys": True, "realBrowser": True,
                "administratorJourneyPassed": True, "ordinaryUserJourneyPassed": True,
                "localeThemeViewportMatrixPassed": True, "sessionAndCsrfPassed": True,
                "sseAndWebSocketPassed": True,
                "originClass": "supported-appliance-authenticated-https",
                "origin": "https://10.64.0.20:18443/", "target": "dgx-spark-dev-01",
                "architecture": "linux/arm64/v8", "certificateTrust": "private-appliance-ca-browser-trusted",
                "browserName": "Chromium", "browserExecution": "real-browser",
                "matrixCombinationCount": 8, "administratorJourneyCount": 2,
                "ordinaryUserJourneyCount": 2, "hostAllowlistDriftCount": 0,
                "hardwareCheckpointAgeSeconds": 120, "hardwareCheckpointMaximumAgeSeconds": 3600,
                "deploymentEvidenceDigest": SHA, "hostDriftEvidenceDigest": SHA,
                "hardwareEvidenceDigest": SHA, "browserEvidenceDigest": SHA,
            },
        }
        browser_report = valid_report()
        browser_report["startedAt"] = (self.now - timedelta(minutes=45)).isoformat().replace("+00:00", "Z")
        browser_report["finishedAt"] = (self.now - timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
        browser_report["hardwareCheckpoint"]["capturedAt"] = (self.now - timedelta(hours=1)).isoformat().replace("+00:00", "Z")
        browser_report["hardwareCheckpoint"]["ageAtCompletionSeconds"] = 1800
        browser_report["evidenceDigest"] = browser_digest({key: item for key, item in browser_report.items() if key != "evidenceDigest"})
        browser_path = root / "appliance-browser-report.json"
        browser_path.write_bytes(json.dumps(browser_report, sort_keys=True, separators=(",", ":")).encode())
        claims["appliance_acceptance"] = validate_browser(browser_path, evaluated_at=self.now)["claims"]
        refs = []
        for key, value in claims.items():
            path = root / f"{key}.json"
            source = None
            if key == "appliance_acceptance":
                source = {"path": browser_path.name, "digest": digest_bytes(browser_path.read_bytes())}
            path.write_bytes(json.dumps(self.envelope(root, key, value, source), sort_keys=True, separators=(",", ":")).encode())
            refs.append({"path": path.name, "digest": digest_bytes(path.read_bytes())})
        return {"schemaVersion": 1, "releaseCandidateId": "rc-test-1", "releaseDigest": SHA, "sourceRevision": REV, "sourceTreeDigest": SHA, "environmentDigest": SHA, "createdAt": (self.now - timedelta(hours=2)).isoformat().replace("+00:00", "Z"), "evidence": refs}

    def test_catalog_is_closed_fail_fast_and_complete(self) -> None:
        value = validate_catalog(self.catalog)
        self.assertEqual([item["key"] for item in value["commandGates"]], ["strict_openspec", "ci", "no_regression"])
        self.assertEqual(len(value["artifactGates"]), 7)
        self.assertTrue(value["requireCleanWorktree"])

    def test_complete_release_candidate_evidence_passes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            values = validate_manifest_and_evidence(self.complete_manifest(root), evidence_root=root, evaluated_at=self.now)
            self.assertEqual(len(values), 7)

    def test_rejects_smoke_short_or_unmatched_soak(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self.complete_manifest(root)
            path = root / "model_soak.json"
            value = json.loads(path.read_text())
            value["claims"]["selectedDurationHours"] = 8
            value["claims"]["completedDurationSeconds"] = 28800
            path.write_bytes(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())
            manifest["evidence"][2]["digest"] = digest_bytes(path.read_bytes())
            with self.assertRaisesRegex(ReleaseGateError, "risk selection"):
                validate_manifest_and_evidence(manifest, evidence_root=root, evaluated_at=self.now)

    def test_rejects_changed_stale_and_missing_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self.complete_manifest(root)
            manifest["evidence"].pop(-2)
            with self.assertRaisesRegex(ReleaseGateError, "exactly one upgrade_rollback"):
                validate_manifest_and_evidence(manifest, evidence_root=root, evaluated_at=self.now)

    def test_rejects_local_http_or_untrusted_browser_appliance_claim(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self.complete_manifest(root)
            path = root / "appliance_acceptance.json"
            value = json.loads(path.read_text())
            value["claims"]["origin"] = "http://localhost:18080/"
            path.write_bytes(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())
            manifest["evidence"][-1]["digest"] = digest_bytes(path.read_bytes())
            with self.assertRaisesRegex(ReleaseGateError, "non-local HTTPS"):
                validate_manifest_and_evidence(manifest, evidence_root=root, evaluated_at=self.now)

            manifest = self.complete_manifest(root)
            path = root / "appliance_acceptance.json"
            value = json.loads(path.read_text())
            value["claims"]["certificateTrust"] = "development-CA-not-installed-in-browser-trust-store"
            path.write_bytes(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())
            manifest["evidence"][-1]["digest"] = digest_bytes(path.read_bytes())
            with self.assertRaisesRegex(ReleaseGateError, "not browser trusted"):
                validate_manifest_and_evidence(manifest, evidence_root=root, evaluated_at=self.now)

            manifest = self.complete_manifest(root)
            path = root / "appliance_acceptance.json"
            value = json.loads(path.read_text())
            value["claims"]["browserEvidenceDigest"] = "sha256:" + "f" * 64
            path.write_bytes(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())
            manifest["evidence"][-1]["digest"] = digest_bytes(path.read_bytes())
            with self.assertRaisesRegex(ReleaseGateError, "not derived"):
                validate_manifest_and_evidence(manifest, evidence_root=root, evaluated_at=self.now)

            manifest = self.complete_manifest(root)
            manifest["releaseDigest"] = "sha256:" + "c" * 64
            with self.assertRaisesRegex(ReleaseGateError, "does not bind releaseDigest"):
                validate_manifest_and_evidence(manifest, evidence_root=root, evaluated_at=self.now)


if __name__ == "__main__":
    unittest.main()
