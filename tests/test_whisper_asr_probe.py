import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class WhisperAsrProbeTests(unittest.TestCase):
    def test_probe_is_content_safe_and_uses_the_openai_audio_shape(self):
        path = ROOT / "tools/whisper_asr_probe.py"
        source = path.read_text(encoding="utf-8")
        completed = subprocess.run(["python3", "-m", "py_compile", str(path)], text=True, capture_output=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("/v1/audio/transcriptions", source)
        self.assertIn('"retainedAudioOrTranscriptContent": False', source)
        self.assertIn("resultDigest", source)
        self.assertNotIn("transcriptText", source)


if __name__ == "__main__":
    unittest.main()
