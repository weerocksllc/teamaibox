from __future__ import annotations

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class AirPlayMainHardwareInventoryTest(unittest.TestCase):
    def test_runner_inventories_real_media_prerequisites(self) -> None:
        source = (ROOT / "tools/run_airplay_main_hardware_inventory.py").read_text()
        for token in ("xrandr", "/dev/dri/card0", "/dev/dri/renderD128", "/dev/snd",
                      "gst-inspect-1.0", "webrtcbin", "avahi-daemon", "sameLayer2Required"):
            self.assertIn(token, source)

    def test_decision_is_fail_closed_without_synthetic_substitution(self) -> None:
        source = (ROOT / "tools/run_airplay_main_hardware_inventory.py").read_text()
        self.assertIn('"supportedEnvironment": False', source)
        self.assertIn('"syntheticSubstitutionAllowed": False', source)
        self.assertIn('"physical_apple_sender_not_exercised"', source)
        self.assertIn('"realHdmiValidated": False', source)

    def test_validator_rechecks_stable_live_hardware(self) -> None:
        source = (ROOT / "tools/validate_airplay_main_hardware_inventory.py").read_text()
        self.assertIn("live = inspect_live()", source)
        self.assertIn('live["display"]["hdmiConnectorPresent"] is True', source)
        self.assertIn('"task22_2Complete": True', source)


if __name__ == "__main__":
    unittest.main()
