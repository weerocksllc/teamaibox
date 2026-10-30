from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class Qwen38ModelOptRuntimeTests(unittest.TestCase):
    def test_dockerfile_pins_modelopt_and_arm64_runtime_contract(self):
        source = (ROOT / "deploy/compute/qwen38-modelopt/Dockerfile").read_text()
        self.assertIn("51cc5dbadeedd93cba5cc37eec637f26efd3f8ab", source)
        self.assertIn("local/vllm:26.06-tf-gemma-assistant-2c7d", source)
        self.assertIn("--no-build-isolation --no-deps /opt/modelopt", source)
        self.assertIn("unexpected=[x for x in lines if x not in allowed]", source)

if __name__ == "__main__":
    unittest.main()
