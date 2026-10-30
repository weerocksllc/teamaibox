import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AgentRuntimeTimeoutTest(unittest.TestCase):
    def test_inner_adapter_allows_qwen38_cold_latency(self):
        source = (ROOT / "deploy/agent/opencode-bridge-main.mjs").read_text(encoding="utf-8")
        self.assertIn("timeoutMs: 120_000", source)
        self.assertNotIn("timeoutMs: 30_000", source)

    def test_successor_layers_only_the_reviewed_bridge_entrypoint(self):
        source = (ROOT / "deploy/agent/AgentSandboxTimeoutRuntime.Dockerfile").read_text(encoding="utf-8")
        self.assertIn("ARG BASE_IMAGE", source)
        self.assertIn("FROM ${BASE_IMAGE}", source)
        self.assertIn("opencode-bridge-main.mjs", source)

if __name__ == "__main__":
    unittest.main()
