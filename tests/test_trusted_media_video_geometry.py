"""Metadata-only geometry tests: no user media, source names, or credentials."""
import os
from types import SimpleNamespace
from threading import Thread
import unittest
import importlib.util
import time

from services.trusted_media_service.video_geometry import parse_geometry
from services.trusted_media_service.native_receiver_process import NativeReceiverProcess
from services.trusted_media_service.media_progress import project_progress, validate_progress
from services.trusted_media_service.gdp_media_ingress import GdpMediaIngress


class VideoGeometryTest(unittest.TestCase):
    def test_exact_numeric_report_and_rejection_of_private_text(self):
        self.assertEqual(parse_geometry(b'TBG1 1320 2868 1080 1920\n'),
                         dict(sourceWidth=1320, sourceHeight=2868, displayWidth=1080, displayHeight=1920))
        for line in (b'TBG1 0 0 0 0\n', b'TBG1 9999 1080 1920 1080\n',
                     b'TBG1 nan 1080 1920 1080\n', b'TBG1 1920 1080 1920 1080 secret\n',
                     b'private TBG1 1920 1080 1920 1080\n', b'x'*8192,
                     b'TBG1 1920 1080 1920 1080\nsecret'):
            self.assertIsNone(parse_geometry(line))

    def test_private_pipe_fragmentation_and_format_switch_replace_only_geometry(self):
        read, write = os.pipe()
        stream = os.fdopen(read, 'rb', buffering=0)
        receiver = SimpleNamespace(_process=SimpleNamespace(stderr=stream), _assertion_code=None, _geometry=None)
        def emit():
            try:
                for part in (b'private label\n', b'x'*8192, b'\nTBG1 1920 1080 1920 1080\n',
                             b'TBG1 1320 2868 ', b'1080 1920\n'):
                    os.write(write, part)
            finally:
                os.close(write)
        writer = Thread(target=emit); writer.start()
        try:
            NativeReceiverProcess._read_assertion(receiver)
            self.assertEqual(receiver._geometry['displayHeight'], 1920)
            self.assertIsNone(receiver._assertion_code)
        finally:
            stream.close(); writer.join(3)
        self.assertFalse(writer.is_alive())

    def test_geometry_does_not_authorize_sender(self):
        receiver = SimpleNamespace(_geometry=parse_geometry(b'TBG1 1920 1080 1920 1080\n'),
                                   authorized_source_id=lambda: None)
        self.assertEqual(NativeReceiverProcess.video_geometry(receiver), {})
        receiver.authorized_source_id = lambda: 'paired-source'
        self.assertEqual(NativeReceiverProcess.video_geometry(receiver)['sourceWidth'], 1920)

    def test_private_health_keeps_only_dimensions_and_pixel_aspect(self):
        value = project_progress({'tracks': {'video': {'caps': dict(width=1440, height=1080,
            pixelAspectNumerator=4, pixelAspectDenominator=3, secret='private')}}}, {},
            dict(sourceWidth=1920, sourceHeight=1080, displayWidth=1920, displayHeight=1080, secret='private'))
        self.assertNotIn('private', repr(value)); self.assertNotIn('secret', repr(value))
        self.assertEqual(value['decodedWidth'], 1440)
        self.assertEqual(value['pixelAspectNumerator'], 4)
        self.assertEqual(value['browserState'], 'absent')
        with self.assertRaises(ValueError):
            validate_progress({**value, 'sourceWidth': 8193})
        with self.assertRaises(ValueError):
            validate_progress({**value, 'decodedWidth': True})


@unittest.skipUnless(importlib.util.find_spec('gi') is not None, 'container GStreamer required')
class DynamicVideoGeometryTest(unittest.TestCase):
    def test_same_gdp_stream_follows_landscape_portrait_and_pixel_aspect_changes(self):
        vr, vw = os.pipe(); ar, aw = os.pipe()
        ingress = GdpMediaIngress(video_fd=vr, audio_fd=ar)
        Gst = ingress._Gst
        pipeline = Gst.parse_launch('appsrc name=feed is-live=true format=time ! gdppay ! fdsink sync=false fd='+str(vw))
        feed = pipeline.get_by_name('feed')
        pipeline.set_state(Gst.State.PLAYING)
        pts = 0
        try:
            for width, height, par_n, par_d in ((640, 360, 1, 1), (360, 640, 1, 1),
                                              (640, 480, 4, 3), (640, 360, 1, 1)):
                caps = Gst.Caps.from_string(f'video/x-raw,format=I420,width={width},height={height},framerate=30/1,pixel-aspect-ratio={par_n}/{par_d}')
                feed.set_property('caps', caps)
                matching = 0
                for _ in range(12):
                    buffer = Gst.Buffer.new_allocate(None, width*height*3//2, None)
                    buffer.memset(0, 0, buffer.get_size())
                    buffer.pts, buffer.duration = pts, Gst.SECOND//30
                    pts += buffer.duration
                    self.assertEqual(feed.emit('push-buffer', buffer), Gst.FlowReturn.OK)
                    sample = ingress.pull('video', timeout_ms=50)
                    if sample is not None:
                        actual = ingress.snapshot()['tracks']['video']['caps']
                        if (actual['width'], actual['height']) == (width, height):
                            matching += 1
                            self.assertEqual((actual['pixelAspectNumerator'], actual['pixelAspectDenominator']), (par_n, par_d))
                    time.sleep(.005)
                self.assertGreaterEqual(matching, 3)
            self.assertEqual(ingress.snapshot()['tracks']['video']['state'], 'receiving')
        finally:
            ingress.close(); pipeline.set_state(Gst.State.NULL)
            for fd in (vr, vw, ar, aw):
                os.close(fd)


if __name__ == '__main__':
    unittest.main()
