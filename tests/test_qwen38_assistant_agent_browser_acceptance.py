import unittest

from tools import validate_qwen38_assistant_agent_browser_acceptance as validator


class Qwen38AssistantAgentBrowserAcceptanceTests(unittest.TestCase):
    def test_exact_model_identity(self):
        self.assertEqual(validator.MODEL_ALIAS, "local/qwen3.8-27b-nvfp4")
        self.assertEqual(validator.PROFILE_KEY, "llm.qwen38-27b.modelopt-nvfp4-fp8.spark23-32k.v1")

    def test_operation_matrix_requires_both_users_and_modes(self):
        self.assertIn("ownerAnswerCompleted", validator.OPERATIONS)
        self.assertIn("ownerAgentCompleted", validator.OPERATIONS)
        self.assertIn("memberAnswerCompleted", validator.OPERATIONS)
        self.assertIn("memberAgentCompleted", validator.OPERATIONS)
        self.assertIn("crossUserDetailDenied", validator.OPERATIONS)

    def test_run_identity_is_bounded(self):
        self.assertIsNotNone(validator.RUN_ID.fullmatch("qwen38-assistant-agent-browser-20260903-a1"))
        self.assertIsNone(validator.RUN_ID.fullmatch("current-assistant-agent-browser-20260903-a1"))
        self.assertIsNone(validator.RUN_ID.fullmatch("qwen38-assistant-agent-browser-latest"))

    def test_system_trust_sources_are_bound(self):
        self.assertTrue(validator.COMMON.name.endswith("browser_smoke_common.mjs"))
        self.assertTrue(validator.PRELOAD.name.endswith("trusted_browser_preload.mjs"))


if __name__ == "__main__":
    unittest.main()
