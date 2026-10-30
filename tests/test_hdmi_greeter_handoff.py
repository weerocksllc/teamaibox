from pathlib import Path
import sys
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import run_hdmi_greeter_handoff as handoff


class HandoffSeatTests(unittest.TestCase):
    def test_unbounded_durations_refused_before_host_access(self):
        import run_trusted_media_hdmi_component as component
        import probe_trusted_media_hdmi as probe
        for duration in (0, 4, 61, True, "60", float("inf")):
            with patch.object(handoff, "checked") as checked:
                with self.assertRaises(ValueError):
                    handoff.run("unused", "unused", duration)
                checked.assert_not_called()
            with self.assertRaises(ValueError):
                component.run("unused", False, duration)
            with patch.object(probe, "prepare_private_devices") as prepare:
                with self.assertRaises(ValueError):
                    probe.run(1, "HDMI-A-1", 0, 3, duration, False)
                prepare.assert_not_called()

    def test_physical_seat_only(self):
        responses = ["seat0", "c1", "Class=greeter\nType=wayland\nRemote=no\nSeat=seat0\nState=active"]
        with patch.object(handoff, "checked", side_effect=responses) as checked:
            self.assertEqual(len(handoff.seats()), 1)
        self.assertNotIn("list-sessions", str(checked.call_args_list))

    def test_logged_in_desktop_refused(self):
        responses = ["seat0", "c1 3", "Class=greeter\nRemote=no\nSeat=seat0", "Class=user\nRemote=no\nSeat=seat0"]
        with patch.object(handoff, "checked", side_effect=responses):
            with self.assertRaisesRegex(ValueError, "desktop session"):
                handoff.seats()

    def test_missing_greeter_refused(self):
        with patch.object(handoff, "checked", return_value=""):
            with self.assertRaisesRegex(ValueError, "greeter required"):
                handoff.seats()

    def test_disappearing_session_refused(self):
        with patch.object(handoff, "checked", side_effect=["seat0", "c1", RuntimeError("session gone")]):
            with self.assertRaises(RuntimeError):
                handoff.seats()


if __name__ == "__main__":
    unittest.main()
