import hashlib
import json
import pathlib
import tempfile
import unittest

from tools.validate_core_service_survival_evidence import EvidenceError, canonical_digest, validate


ROOT = pathlib.Path(__file__).resolve().parents[1]
POLICY = ROOT / "deploy/compose/resource-policy.json"


class CoreServiceSurvivalEvidenceTests(unittest.TestCase):
    def evidence(self):
        run_id = "20260812-core-survival-a1"
        objectives = json.loads(POLICY.read_text(encoding="utf-8"))["serviceObjectives"]
        containers = {
            role: {
                "name": f"teamaibox-validation-{run_id}-survival-{role}",
                "containerId": f"{index + 1:x}" * 64,
                "running": True,
                "validationRunLabel": run_id,
            }
            for index, role in enumerate((
                "platform", "web", "object", "messaging", "postgres", "queue", "scheduler", "ai",
            ))
        }
        container_digest = canonical_digest(containers)
        result_material = {
            "containerIdentityDigest": container_digest,
            "domains": sorted(objectives),
            "functionalObjectives": True,
            "objectivePolicy": objectives,
            "passed": True,
            "probesPerDomain": 8,
            "runId": run_id,
            "target": "dgx-spark-dev-01",
        }
        attestation = {
            "schemaVersion": 1,
            "kind": "core-service-objectives",
            "passed": True,
            "functionalObjectives": True,
            "runId": run_id,
            "target": "dgx-spark-dev-01",
            "containerIdentityDigest": container_digest,
            "domains": sorted(objectives),
            "probesPerDomain": 8,
            "objectivePolicyDigest": canonical_digest(objectives),
            "resultDigest": canonical_digest(result_material),
        }
        measurement = {
            "schemaVersion": 1,
            "runId": run_id,
            "target": "dgx-spark-dev-01",
            "passed": True,
            "containers": containers,
            "domains": {domain: True for domain in sorted(objectives)},
            "maximumLatencyMilliseconds": {domain: 10 for domain in sorted(objectives)},
            "probesPerDomain": 8,
            "objectives": {domain: {
                "healthy": True,
                "probes": 8,
                "successRate": 1.0,
                "minimumSuccessRate": 1.0,
                "maximumLatencyMilliseconds": 10,
                "maximumAllowedLatencyMilliseconds": objectives[domain]["maximumLatencyMilliseconds"],
            } for domain in sorted(objectives)},
            "stress": {
                "running": True, "memoryLimitBytes": 1_073_741_824, "cpuLimitCores": 2,
                "network": "none", "containerName": f"teamaibox-validation-{run_id}-survival-ai",
                "workerCount": 4, "touchedBytes": 536_870_912,
            },
        }
        rendered = (
            json.dumps(measurement, sort_keys=True, separators=(",", ":")) + "\n"
            + json.dumps(attestation, sort_keys=True, separators=(",", ":")) + "\n"
        )
        output_digest = "sha256:" + hashlib.sha256(rendered.encode()).hexdigest()
        return {
            "schemaVersion": 1,
            "runId": run_id,
            "target": "dgx-spark-dev-01",
            "architecture": "linux/arm64/v8",
            "claimEligible": True,
            "cleanupPassed": True,
            "residualStatePassed": True,
            "sourceTreeDigest": "sha256:" + "b" * 64,
            "deviceBaselineDigest": "sha256:" + hashlib.sha256((ROOT / "evidence/hardware/dgx-spark-dev-01/inventory-2026-08-10.json").read_bytes()).hexdigest(),
            "suites": ["core-service-survival"],
            "suiteArtifacts": {"coreServiceSurvival": {
                "measurement": measurement,
                "attestation": attestation,
                "outputDigest": output_digest,
                "runnerSourceDigest": "sha256:" + hashlib.sha256((ROOT / "tools/spark_validation.py").read_bytes()).hexdigest(),
                "retainedRequestOrResponseContent": False,
            }},
            "steps": [{
                "name": "core-service-survival", "required": True, "passed": True,
                "returnCode": 0, "stdoutDigest": output_digest, "sanitizedOutputTail": [],
            }],
        }

    def write(self, value):
        directory = pathlib.Path(tempfile.mkdtemp())
        path = directory / "core-service-survival-20260812-a1.json"
        path.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")
        self.addCleanup(lambda: __import__("shutil").rmtree(directory))
        return path

    def test_accepts_functional_exact_objective_spark_evidence(self):
        result = validate(self.write(self.evidence()), POLICY)
        self.assertTrue(result["valid"])
        self.assertEqual(result["probesPerDomain"], 8)

    def test_rejects_legacy_health_only_or_policy_drift(self):
        legacy = self.evidence()
        legacy["suiteArtifacts"] = {}
        with self.assertRaises(EvidenceError):
            validate(self.write(legacy), POLICY)
        drifted = self.evidence()
        drifted["suiteArtifacts"]["coreServiceSurvival"]["attestation"]["objectivePolicyDigest"] = "sha256:" + "0" * 64
        with self.assertRaises(EvidenceError):
            validate(self.write(drifted), POLICY)

    def test_rejects_fabricated_latency_and_saturation_identity(self):
        value = self.evidence()
        measurement = value["suiteArtifacts"]["coreServiceSurvival"]["measurement"]
        measurement["maximumLatencyMilliseconds"]["identity"] = 1001
        with self.assertRaisesRegex(EvidenceError, "output lineage drifted"):
            validate(self.write(value), POLICY)

    def test_rejects_cross_run_path_target_and_container_substitution(self):
        value = self.evidence()
        path = self.write(value).with_name("core-service-survival-20260812-a2.json")
        path.write_text(json.dumps(value), encoding="utf-8")
        with self.assertRaisesRegex(EvidenceError, "path does not match"):
            validate(path, POLICY)

        value = self.evidence()
        value["target"] = "dgx-spark-worker-02"
        with self.assertRaisesRegex(EvidenceError, "primary Spark target"):
            validate(self.write(value), POLICY)

        value = self.evidence()
        measurement = value["suiteArtifacts"]["coreServiceSurvival"]["measurement"]
        measurement["containers"]["ai"]["name"] = "teamaibox-validation-other-run-survival-ai"
        rendered = (
            json.dumps(measurement, sort_keys=True, separators=(",", ":")) + "\n"
            + json.dumps(value["suiteArtifacts"]["coreServiceSurvival"]["attestation"], sort_keys=True, separators=(",", ":")) + "\n"
        )
        digest = "sha256:" + hashlib.sha256(rendered.encode()).hexdigest()
        value["suiteArtifacts"]["coreServiceSurvival"]["outputDigest"] = digest
        value["steps"][0]["stdoutDigest"] = digest
        with self.assertRaisesRegex(EvidenceError, "container identity drifted"):
            validate(self.write(value), POLICY)
        value = self.evidence()
        measurement = value["suiteArtifacts"]["coreServiceSurvival"]["measurement"]
        measurement["stress"]["network"] = "bridge"
        with self.assertRaisesRegex(EvidenceError, "output lineage drifted"):
            validate(self.write(value), POLICY)


if __name__ == "__main__":
    unittest.main()
