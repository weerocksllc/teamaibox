from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class AgentUserFleetTest(unittest.TestCase):
    def test_fleet_requires_explicit_protected_configuration_without_account_defaults(self):
        initializer = (ROOT / "deploy/agent/product-agent-init.mjs").read_text(encoding="utf-8")
        self.assertIn("loadAgentIdentities(process.env.TEAMAIBOX_AGENT_IDENTITIES_FILE)", initializer)
        self.assertIn('from "./product-agent-identities.mjs"', initializer)
        self.assertNotIn("loginName:", initializer)
        self.assertNotIn("const definitions = [", initializer)
        self.assertIn("for (const definition of definitions)", initializer)
        self.assertIn("findByNormalizedLogin(definition.loginName)", initializer)

    def test_sandbox_is_unprivileged_and_opencode_is_pinned(self):
        dockerfile = (ROOT / "deploy/agent/AgentSandbox.Dockerfile").read_text(encoding="utf-8")
        self.assertIn("USER 65532:65532", dockerfile)
        self.assertIn("OPENCODE_DISABLE_PROJECT_CONFIG=1", dockerfile)
        self.assertIn("OPENCODE_DISABLE_SHARE=1", dockerfile)
        self.assertIn("1.18.16", dockerfile)


if __name__ == "__main__":
    unittest.main()
