from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class AgentModelAliasImageEmbeddingTests(unittest.TestCase):
    def test_platform_and_gateway_images_embed_the_alias_map(self) -> None:
        expected = "deploy/compose/agent-model-aliases.v1.json /run/config/agent-model-aliases.json"
        for relative in (
            "deploy/images/platform-api.Dockerfile",
            "deploy/images/compute-gateway.Dockerfile",
        ):
            self.assertIn(expected, (ROOT / relative).read_text(encoding="utf-8"))

    def test_compose_does_not_bind_the_alias_map_from_host_source(self) -> None:
        for relative in ("deploy/compose/core.yaml",):
            source = (ROOT / relative).read_text(encoding="utf-8")
            self.assertNotIn("source: agent_model_aliases", source)
            self.assertNotIn("file: ./deploy/compose/agent-model-aliases.v1.json", source)
            self.assertNotIn("file: ./agent-model-aliases.v1.json", source)


if __name__ == "__main__":
    unittest.main()
