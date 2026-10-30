from datetime import datetime, timezone
import unittest
from unittest.mock import Mock, patch

from services.trusted_media_service.output_readiness import OutputReadiness, node_identity


IDENTITY = {"nodeId": "10000000-0000-4000-8000-000000000001", "nodeGeneration": 2}


class OutputReadinessTest(unittest.TestCase):
    def setUp(self):
        self.rooms, self.device, self.hdmi, self.gst = Mock(), Mock(), Mock(), Mock()
        self.rooms.probe.return_value = True
        self.hdmi.device.return_value = self.device
        self.probe = OutputReadiness(identity=IDENTITY, interface="eth0", rooms=self.rooms,
            clock=lambda: 1788700000, gst=lambda: self.gst)
        self.network = patch.object(self.probe, "_network_and_receiver", return_value=True)
        self.network.start(); self.addCleanup(self.network.stop)

    def test_fresh_checks_create_no_room_media_graph_or_desktop_changes(self):
        result = self.probe.snapshot()
        self.assertEqual(result["outputs"], {sink: {"available": True, "reasonCode": None} for sink in ("browser",)})
        self.assertEqual(result["nodeId"], IDENTITY["nodeId"])
        self.assertEqual(datetime.fromisoformat(result["observedAt"].replace("Z", "+00:00")).timestamp(), 1788700000)
        self.rooms.create.assert_not_called()
        self.gst.Pipeline.new.assert_not_called()
        self.device.acquire.assert_not_called(); self.device.release.assert_not_called()
        self.probe.snapshot()
        self.assertEqual(self.rooms.probe.call_count, 2)  # Never cache readiness.

    def test_legacy_display_config_is_rejected_without_probing_devices(self):
        with self.assertRaisesRegex(ValueError, "cast_runtime_output_invalid"):
            OutputReadiness(identity=IDENTITY, interface="eth0", rooms=self.rooms, hdmi=self.hdmi)
        self.hdmi.device.assert_not_called()

    def test_sfu_failure_is_redacted_and_independent_of_hdmi(self):
        self.rooms.probe.side_effect = RuntimeError("secret token / device detail")
        result = self.probe.snapshot()
        self.assertNotIn("hdmi", result["outputs"])
        self.assertEqual(result["outputs"]["browser"], {"available": False, "reasonCode": "cast_sfu_unavailable"})
        self.assertNotIn("secret", str(result))

    def test_missing_decoder_fails_both_outputs_without_opening_devices(self):
        self.gst.ElementFactory.find.side_effect = lambda name: None if name == "avdec_h264" else Mock()
        result = self.probe.snapshot()
        self.assertTrue(all(not value["available"] for value in result["outputs"].values()))
        self.device.acquire.assert_not_called(); self.rooms.probe.assert_not_called()

    def test_no_monitor_or_speakers_are_required_by_browser_readiness(self):
        result = self.probe.snapshot()
        self.assertEqual(set(result["outputs"]), {"browser"})
        self.assertTrue(result["outputs"]["browser"]["available"])
        self.hdmi.device.assert_not_called()

    def test_missing_webrtc_transport_never_reports_ready_or_contacts_sfu(self):
        for missing in ("webrtcbin", "nicesrc", "nicesink", "dtlssrtpenc", "dtlssrtpdec",
                        "sctpenc", "sctpdec", "rtpbin"):
            with self.subTest(missing=missing):
                self.rooms.probe.reset_mock()
                self.gst.ElementFactory.find.side_effect = lambda name: None if name == missing else Mock()
                result = self.probe.snapshot()
                self.assertEqual(result["outputs"]["browser"],
                                 {"available": False, "reasonCode": "cast_sfu_unavailable"})
                self.rooms.probe.assert_not_called()
                self.gst.Pipeline.new.assert_not_called()

    def test_invalid_node_or_generation_rejected(self):
        for value in ({}, {**IDENTITY, "nodeGeneration": True}, {**IDENTITY, "nodeGeneration": 0},
                      {**IDENTITY, "nodeId": "/dev/dri/card0"}, {**IDENTITY, "extra": "field"}):
            with self.subTest(value=value), self.assertRaises(ValueError): node_identity(value)


if __name__ == "__main__": unittest.main()
