import json
import py_compile
import unittest
from pathlib import Path

from tools.validate_whisper_asr_deployment import validate


class WhisperAsrDeploymentTests(unittest.TestCase):
    def test_runtime_declarations_do_not_embed_an_appliance_address(self):
        for version in (1, 2):
            with self.subTest(version=version):
                declaration = json.loads(Path(f"deploy/compute/asr-whisper-large-v3-runtime.v{version}.json").read_text())
                self.assertEqual(declaration["publishedEndpoint"], {
                    "hostFromEnvironment": "TEAMAIBOX_ASR_PUBLISH_HOST", "port": 18083, "containerPort": 8080,
                })

    def test_profile_is_immutable_arm64_content_safe_and_openai_compatible(self):
        result = validate()
        self.assertEqual(result["candidateId"], "whisper-large-v3-fp16")
        self.assertRegex(result["profileDigest"], r"^sha256:[0-9a-f]{64}$")
        py_compile.compile("tools/whisper_asr_worker.py", doraise=True)
        worker = Path("tools/whisper_asr_worker.py").read_text(encoding="utf-8")
        self.assertNotIn("import subprocess", worker)
        self.assertNotIn(".m4a", worker)


if __name__ == "__main__":
    unittest.main()
