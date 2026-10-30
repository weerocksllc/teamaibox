"""Synthetic raw frames exercise the exact native converter, not Apple proof."""
import importlib.util
import time
import unittest

from services.trusted_media_service.native_receiver_process import VIDEO_CONVERTER_PIPELINE
from services.trusted_media_service.gdp_media_ingress import _gstreamer


@unittest.skipUnless(importlib.util.find_spec("gi"), "container GStreamer required")
class VideoNormalizationTest(unittest.TestCase):
    def convert(self, format_name, rate, *, variable=False, portrait=False):
        G = _gstreamer()
        width, height = (480, 640) if portrait else (640, 480)
        text = (f"videotestsrc num-buffers=60 ! video/x-raw,format={format_name},"
                f"width={width},height={height},framerate={rate}/1 ! "
                + ("capssetter caps=video/x-raw,framerate=0/1 ! " if variable else "")
                + VIDEO_CONVERTER_PIPELINE + " ! appsink name=result sync=false")
        pipe = G.parse_launch(text)
        sink = pipe.get_by_name("result")
        count, previous = 0, None
        try:
            self.assertNotEqual(pipe.set_state(G.State.PLAYING), G.StateChangeReturn.FAILURE)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                sample = sink.try_pull_sample(50 * G.MSECOND)
                if sample is None:
                    if sink.is_eos(): break
                    continue
                caps, buffer = sample.get_caps().get_structure(0), sample.get_buffer()
                self.assertEqual(caps.get_value("format"), "I420")
                self.assertEqual(caps.get_fraction("framerate"), (True, 30, 1))
                self.assertEqual((caps.get_value("width"), caps.get_value("height")), (width, height))
                self.assertLessEqual(buffer.get_size(), width * height * 2)
                self.assertNotEqual(buffer.pts, G.CLOCK_TIME_NONE)
                if previous is not None: self.assertGreater(buffer.pts, previous)
                previous = buffer.pts
                count += 1
            self.assertIsNone(pipe.get_bus().pop_filtered(G.MessageType.ERROR))
            self.assertTrue(sink.is_eos())
            self.assertGreater(count, 0)
            self.assertLessEqual(count, 31 if rate == 60 else 60)
        finally:
            pipe.set_state(G.State.NULL)

    def test_y444_is_converted_and_sixty_fps_is_actually_limited(self):
        self.convert("Y444", 60)

    def test_y42b_is_converted_without_geometry_change(self):
        self.convert("Y42B", 30)

    def test_rgb_portrait_is_converted_without_rotation_or_upscaling(self):
        self.convert("RGBx", 30, portrait=True)

    def test_variable_rate_caps_are_normalized_without_unbounded_duplication(self):
        self.convert("Y444", 60, variable=True)

    def test_already_compatible_i420_remains_compatible(self):
        self.convert("I420", 30)
