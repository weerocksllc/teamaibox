import copy
import json
import pathlib
import tempfile
import unittest
from unittest import mock

from tools import validate_opencode_compatibility_gate as compatibility


class OpenCodeCompatibilityGateTests(unittest.TestCase):
    def setUp(self):
        self.archived_gate = compatibility.GATE
        self.archived_evidence = compatibility.EVIDENCE
        directory = tempfile.TemporaryDirectory(prefix='opencode-contract-unit-')
        self.addCleanup(directory.cleanup)
        gate = json.loads(self.archived_gate.read_text())
        evidence = json.loads(self.archived_evidence.read_text())
        for name in ('adapter', 'registry'):
            gate['implementation'][name+'Sha256'] = compatibility.sha256(
                compatibility.ROOT/gate['implementation'][name+'Path'])
        policy_digest = compatibility.sha256(compatibility.POLICY)
        gate['runtimePolicy']['policySha256'] = policy_digest
        evidence['facts']['runtimePolicySha256'] = policy_digest
        for name, value in [('GATE', gate), ('EVIDENCE', evidence)]:
            path = pathlib.Path(directory.name)/f'{name}.json'
            path.write_text(json.dumps(value))
            patcher = mock.patch.object(compatibility, name, path)
            patcher.start(); self.addCleanup(patcher.stop)

    def test_archived_gate_rejects_changed_adapter(self):
        with mock.patch.object(compatibility, 'GATE', self.archived_gate), mock.patch.object(compatibility, 'EVIDENCE', self.archived_evidence):
            with self.assertRaisesRegex(ValueError, 'adapter changed'):
                compatibility.load_and_validate()

    def test_in_memory_gate_contract_binds_upstream_adapter_and_restricted_runtime(self):
        gate, evidence = compatibility.load_and_validate()
        self.assertEqual(gate["upstreamVersion"], "1.18.16")
        self.assertEqual(evidence["result"], "passed")
        self.assertEqual(gate["runtimePolicy"]["approvedProviders"], ["teamaibox"])
        self.assertEqual(gate["runtimePolicy"]["approvedPlugins"], [])
        self.assertEqual(
            evidence["facts"]["realSparkEvidencePath"],
            "evidence/validation/opencode/opencode-compat-20260812-a6.json",
        )
        self.assertEqual(
            evidence["facts"]["realModelPromptEvidencePath"],
            "evidence/validation/opencode/opencode-prompt-20260812-a5.json",
        )

    def test_version_only_upgrade_fails_closed(self):
        gate = json.loads(compatibility.GATE.read_text())
        drifted = copy.deepcopy(gate)
        drifted["upstreamVersion"] = "1.18.17"
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "compatibility-gate.v1.json"
            path.write_text(json.dumps(drifted))
            with mock.patch.object(compatibility, "GATE", path):
                with self.assertRaisesRegex(ValueError, "version drifted"):
                    compatibility.load_and_validate()

    def test_policy_digest_drift_fails_closed(self):
        gate = json.loads(compatibility.GATE.read_text())
        drifted = copy.deepcopy(gate)
        drifted["runtimePolicy"]["policySha256"] = "0" * 64
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "compatibility-gate.v1.json"
            path.write_text(json.dumps(drifted))
            with mock.patch.object(compatibility, "GATE", path):
                with self.assertRaisesRegex(ValueError, "runtime policy changed"):
                    compatibility.load_and_validate()

    def test_real_spark_evidence_digest_drift_fails_closed(self):
        evidence = json.loads(compatibility.EVIDENCE.read_text())
        drifted = copy.deepcopy(evidence)
        drifted["facts"]["realSparkEvidenceDigest"] = "sha256:" + "0" * 64
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "compatibility-evidence.v1.json"
            path.write_text(json.dumps(drifted))
            with mock.patch.object(compatibility, "EVIDENCE", path):
                with self.assertRaisesRegex(ValueError, "real Spark compatibility evidence drifted"):
                    compatibility.load_and_validate()


if __name__ == "__main__":
    unittest.main()
