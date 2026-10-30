import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ModelCoexistenceProbeTests(unittest.TestCase):
    def test_probe_is_syntax_valid_and_never_emits_prompt_or_output_text(self):
        source = (ROOT / "tools/model_coexistence_probe.mjs").read_text(encoding="utf-8")
        completed = subprocess.run(
            ["node", "--check", str(ROOT / "tools/model_coexistence_probe.mjs")],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("retainPromptOrOutputText: false", source)
        self.assertIn("responseDigest", source)
        self.assertIn("enable_thinking: false", source)
        self.assertIn("message?.reasoning_content", source)
        self.assertNotIn("responseText", source)
        for operation in (
            "functional-message-send-history-and-search",
            "functional-drive-create-list-version-search-and-quota",
            "functional-object-put-head-and-list",
        ):
            self.assertIn(operation, source)


if __name__ == "__main__":
    unittest.main()
