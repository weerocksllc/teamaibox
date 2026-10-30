from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CurrentRealtimeBrowserBindingSourceTests(unittest.TestCase):
    def test_binding_is_read_only_and_exactly_scoped(self):
        runner = (ROOT / "tools/run_current_realtime_browser_binding.py").read_text(encoding="utf-8")
        self.assertIn('PROJECT + "-asr-plugin-1"', runner)
        self.assertIn('PROJECT + "-realtime-asr-worker-1"', runner)
        self.assertIn('"teamaibox.current-browser-runtime-qualification.v1"', runner)
        self.assertNotIn('docker restart', runner)
        self.assertNotIn('docker stop', runner)
        self.assertNotIn('docker rm', runner)

    def test_validator_keeps_human_gate_false_while_binding_current_trust(self):
        validator = (ROOT / "tools/validate_current_realtime_browser_binding.py").read_text(encoding="utf-8")
        self.assertIn('"browserTrustedHttps": True', validator)
        self.assertIn('"independentHumanAcceptance": False', validator)
        self.assertIn('"runtimeBindingOnly": True', validator)


if __name__ == "__main__":
    unittest.main()
