"""HDMI policy/lifecycle tests. Mocks are never physical display evidence."""
import os
from pathlib import Path
import stat
import time
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from services.trusted_media_service.hdmi_media_output import KmsDevice, HdmiMediaOutput, HdmiOutputError

SESSION = "10000000-0000-4000-8000-000000000001"
MODULE = "services.trusted_media_service.hdmi_media_output"


class HdmiPolicyTest(unittest.TestCase):
    def test_typed_device_configuration_rejects_paths_and_options(self):
        for values in ({"card": True}, {"card": -1}, {"card": "1"}, {"connector": "HDMI-A-1/../card0"},
                       {"audio_device": "3; command"}, {"audio_card": -1}, {"audio_device": 0}):
            with self.assertRaises(ValueError):
                KmsDevice(**({"card": 1, "connector": "HDMI-A-1"} | values))

    def test_disconnected_does_not_open_any_device(self):
        device = KmsDevice(card=1, connector="HDMI-A-1")
        with patch.object(device, "connected", return_value=False), patch(MODULE + ".os.open") as opened:
            with self.assertRaisesRegex(HdmiOutputError, "disconnected"):
                device.acquire()
            opened.assert_not_called()

    def acquire_with_master(self, master, wrong_device=False, refresh=False, pointer=19):
        device = KmsDevice(card=1, connector="HDMI-A-1")
        library = MagicMock()
        library.drmIsMaster.return_value = master
        library.drmModeGetConnector.return_value = pointer
        fake_stat = SimpleNamespace(st_mode=stat.S_IFCHR, st_rdev=226001)
        with patch.object(device, "connected", return_value=True), patch.object(Path, "read_text", return_value="128\n"), \
             patch(MODULE + ".os.stat", return_value=SimpleNamespace(st_mode=stat.S_IFCHR, st_rdev=116002)), \
             patch(MODULE + ".os.major", side_effect=lambda number: number // 1000), \
             patch(MODULE + ".os.minor", return_value=2 if wrong_device else 1), \
             patch(MODULE + ".os.open", return_value=17), patch(MODULE + ".os.fstat", return_value=fake_stat), \
             patch(MODULE + ".ctypes.CDLL", return_value=library), patch(MODULE + ".os.close") as closed:
            if master != 1 or wrong_device or (refresh and not pointer):
                with self.assertRaises(HdmiOutputError) as failure:
                    device.acquire(refresh_connector=refresh)
                if master != 1 and not wrong_device:
                    self.assertEqual(failure.exception.code, "cast_hdmi_display_busy")
                closed.assert_called_once_with(17)
                self.assertIsNone(device.fd)
            else:
                device.acquire(refresh_connector=refresh)
                self.assertEqual((device.fd, device.connector_id, device.alsa), (17, 128, "hw:0,3"))
                device.release()
                device.release()
                closed.assert_called_once_with(17)
            library.drmSetMaster.assert_not_called()
            if refresh and master==1 and not wrong_device:
                library.drmModeGetConnector.assert_called_once_with(17,128)
                if pointer:library.drmModeFreeConnector.assert_called_once_with(pointer)
                else:library.drmModeFreeConnector.assert_not_called()
            else:library.drmModeGetConnector.assert_not_called()

    def test_busy_display_is_not_taken_over(self):
        self.acquire_with_master(0)

    def test_wrong_card_never_becomes_eligible(self):
        self.acquire_with_master(1, wrong_device=True)

    def test_exact_owned_descriptor_is_released_idempotently(self):
        self.acquire_with_master(1)

    def test_managed_start_refreshes_only_naturally_owned_connector(self):
        self.acquire_with_master(1,refresh=True)
        self.acquire_with_master(0,refresh=True)
        self.acquire_with_master(1,wrong_device=True,refresh=True)

    def test_failed_refresh_closes_fd_without_freeing_null_pointer(self):
        self.acquire_with_master(1,refresh=True,pointer=0)

    def output(self):
        return HdmiMediaOutput(session_id=SESSION, expires_at=time.time() + 60,
                               device=KmsDevice(card=1, connector="HDMI-A-1"))

    def test_expiry_is_finite_and_bounded(self):
        for expiry in (float("nan"), float("inf"), 0, True, time.time() + 14402):
            with self.assertRaises(ValueError):
                HdmiMediaOutput(session_id=SESSION, expires_at=expiry, device=KmsDevice(card=1, connector="HDMI-A-1"))

    def test_missing_device_fails_before_gstreamer_or_input(self):
        output = self.output()
        with patch.object(output._device, "acquire", side_effect=HdmiOutputError("cast_hdmi_display_busy")), \
             patch(MODULE + "._gstreamer") as gst:
            with self.assertRaisesRegex(HdmiOutputError, "display_busy"):
                output.start()
            gst.assert_not_called()
            self.assertFalse(output.snapshot()["healthy"])

    def test_failed_teardown_retains_fd_until_null_is_confirmed(self):
        output = self.output()
        gst = SimpleNamespace(State=SimpleNamespace(NULL="null"), StateChangeReturn=SimpleNamespace(FAILURE="failure"), SECOND=1)
        pipeline = MagicMock()
        pipeline.set_state.return_value = "success"
        pipeline.get_state.return_value = ("async", "playing", None)
        output._Gst, output._pipeline = gst, pipeline
        with patch.object(output._device, "release") as release:
            with self.assertRaisesRegex(HdmiOutputError, "cleanup_pending"):
                output.close()
            release.assert_not_called()
            self.assertIs(output._pipeline, pipeline)
            pipeline.get_state.return_value = ("success", "null", None)
            output.close()
            release.assert_called_once()
            self.assertTrue(output._closed)

    def test_disconnected_snapshot_contains_no_private_detail(self):
        output = self.output()
        output._pipeline = MagicMock()
        with patch.object(output._device, "connected", return_value=False):
            self.assertEqual(output.snapshot(), {"healthy": False, "state": "failed",
                                                "reason": "cast_hdmi_disconnected_or_unsupported"})

    def test_hdmi_caps_allow_display_pixel_aspect_negotiation(self):
        # Build the real adapter graph with fake elements, inspect only policy.
        output=self.output();gst=MagicMock();elements=[];caps=[]
        def make(factory,_):
            e=MagicMock();e.factory=factory;elements.append(e);return e
        gst.ElementFactory.make.side_effect=make
        gst.Caps.from_string.side_effect=lambda value:caps.append(value) or value
        gst.Pipeline.new.return_value.get_state.return_value=('success','playing',None)
        output._Gst=gst
        with patch.object(output,'_check'):output._build()
        self.assertIn('video/x-raw,format=BGRA,width=1920,height=1080',caps)
        self.assertFalse(any('pixel-aspect-ratio=1/1' in c for c in caps))
        scale=next(e for e in elements if e.factory=='videoscale')
        scale.set_property.assert_any_call('add-borders',True)
        sources=[e for e in elements if e.factory=='appsrc']
        sources[0].set_property.assert_any_call('max-buffers',8)
        sources[0].set_property.assert_any_call('max-bytes',1920*1080*4*8)
        sources[0].set_property.assert_any_call('max-time',250*gst.MSECOND)
        sources[1].set_property.assert_any_call('max-buffers',32)
        sources[1].set_property.assert_any_call('max-bytes',61440)


if __name__ == "__main__":
    unittest.main()
