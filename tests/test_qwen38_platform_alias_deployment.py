from pathlib import Path
import json
import unittest


ROOT = Path(__file__).resolve().parents[1]


class Qwen38PlatformAliasDeploymentTests(unittest.TestCase):
    def test_alias_is_the_real_qwen38_profile(self):
        value = json.loads((ROOT / "deploy/compose/agent-model-aliases.v1.json").read_text())
        self.assertEqual(value, {"schemaVersion": 1, "aliases": {"agent.default": "local/qwen3.8-27b-nvfp4"}})

    def test_answer_and_agent_disclose_the_exact_physical_profile(self):
        runner = (ROOT / "apps/platform-api/src/assistant/openai-answer-runner.mjs").read_text()
        server = (ROOT / "apps/platform-api/server/platform-api.mjs").read_text()
        self.assertIn("profileKey,", runner)
        self.assertIn("LOCAL_OPENAI_PROFILE_KEY", server)

    def test_platform_persists_external_attempts_for_qwen38(self):
        bridge = (ROOT / "apps/platform-api/src/compute/openai-worker-execution-bridge.mjs").read_text()
        server = (ROOT / "apps/platform-api/server/platform-api.mjs").read_text()
        repository = (ROOT / "services/scheduler/src/postgres-external-attempt-repository.mjs").read_text()
        self.assertIn("externalAttemptRepository", bridge)
        self.assertIn("observeOutput", bridge)
        self.assertIn("PostgresExternalAttemptRepository", server)
        self.assertIn("requested_model_profile_id=COALESCE", repository)
        leases = (ROOT / "services/scheduler/src/postgres-lease-repository.mjs").read_text()
        self.assertIn("NOT EXISTS (", leases)
        self.assertIn("compute.external_attempt_dispatches external_attempt", leases)

    def test_assistant_catalog_is_bound_to_the_exact_qwen38_profile(self):
        catalog = json.loads((ROOT / "deploy/applications/built-in-applications.v1.json").read_text())
        assistant = catalog["applications"][0]
        self.assertEqual(assistant["requiredModelProfiles"], {
            "chat": "llm.qwen38-27b.modelopt-nvfp4-fp8.spark23-32k.v1",
        })
        service = (ROOT / "apps/platform-api/src/applications/application-catalog-service.mjs").read_text()
        self.assertIn("requiredModelProfiles", service)
        self.assertIn("providerRoutableProfiles.includes(requiredProfile)", service)


if __name__ == "__main__":
    unittest.main()
