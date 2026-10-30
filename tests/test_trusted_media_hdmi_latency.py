"""Content-free latency negotiation regressions; never access sound/display devices."""
import time
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from services.trusted_media_service.hdmi_media_output import HdmiMediaOutput, HdmiOutputError, KmsDevice


class HdmiLatencyTest(unittest.TestCase):
    def setUp(self):
        self.output = HdmiMediaOutput(session_id='10000000-0000-4000-8000-000000000001',
            expires_at=time.time()+60, device=KmsDevice(card=1, connector='HDMI-A-1'))
        self.output._device.connected = lambda: True
        self.output._Gst = SimpleNamespace(MessageType=SimpleNamespace(ERROR=1, LATENCY=2))
        self.pipeline = self.output._pipeline = MagicMock()
        self.bus = self.pipeline.get_bus.return_value
        self.bus.pop_filtered.return_value = None
        self.pipeline.recalculate_latency.return_value = True
        self.output._sinks = {m: MagicMock() for m in ('audio', 'video')}
        self.caps('audio', None)
        self.caps('video', None)

    def caps(self, media, text):
        value = None if text is None else MagicMock()
        if value is not None:
            value.is_fixed.return_value = True
            value.to_string.return_value = text
        self.output._sinks[media].get_static_pad.return_value.get_current_caps.return_value = value

    def check(self):
        self.output._latency_retry_at = 0
        self.output._check()

    def test_start_without_caps_defers_then_negotiates_once(self):
        self.check()
        self.pipeline.recalculate_latency.assert_not_called()
        self.caps('audio', 'audio/x-raw,rate=48000')
        self.check(); self.check()
        self.pipeline.recalculate_latency.assert_called_once_with()
        self.assertEqual(self.output._latency_updates, 1)

    def test_latency_message_survives_error_filter_with_unchanged_caps(self):
        self.caps('audio', 'audio/x-raw,rate=48000')
        self.check()
        self.bus.pop_filtered.side_effect = [SimpleNamespace(type=2), None]
        self.check()
        self.assertEqual(self.pipeline.recalculate_latency.call_count, 2)
        self.assertTrue(all(call.args == (3,) for call in self.bus.pop_filtered.call_args_list))

    def test_dynamic_video_caps_recalculates_shared_latency(self):
        self.caps('audio', 'audio/x-raw,rate=48000')
        self.check()
        self.caps('video', 'video/x-raw,width=1920')
        self.check()
        self.caps('video', 'video/x-raw,width=1080')
        self.check()
        self.assertEqual(self.pipeline.recalculate_latency.call_count, 3)
        self.pipeline.set_latency.assert_not_called()

    def test_failed_query_retries_without_false_success(self):
        self.caps('audio', 'audio/x-raw,rate=48000')
        self.pipeline.recalculate_latency.return_value = False
        self.check()
        self.assertTrue(self.output._latency_dirty)
        self.assertEqual(self.output._latency_updates, 0)
        self.pipeline.recalculate_latency.return_value = True
        self.check()
        self.assertEqual(self.output._latency_updates, 1)

    def test_failed_query_retries_are_rate_limited(self):
        self.caps('audio', 'audio/x-raw,rate=48000')
        self.pipeline.recalculate_latency.return_value = False
        with patch('services.trusted_media_service.hdmi_media_output.time.monotonic', return_value=100):
            for _ in range(20): self.output._check()
        self.pipeline.recalculate_latency.assert_called_once_with()

    def test_later_error_is_not_hidden_by_latency(self):
        self.bus.pop_filtered.side_effect = [SimpleNamespace(type=2), SimpleNamespace(type=1)]
        with self.assertRaisesRegex(HdmiOutputError, 'cast_hdmi_output_failed'): self.check()
        self.pipeline.recalculate_latency.assert_not_called()

    def test_latency_message_flood_has_bounded_work(self):
        self.bus.pop_filtered.return_value = SimpleNamespace(type=2)
        self.check()
        self.assertEqual(self.bus.pop_filtered.call_count, 32)

    def test_disconnect_is_fail_closed_before_query(self):
        self.output._device.connected = lambda: False
        with self.assertRaisesRegex(HdmiOutputError, 'disconnected'): self.check()
        self.pipeline.recalculate_latency.assert_not_called()


if __name__ == '__main__': unittest.main()
