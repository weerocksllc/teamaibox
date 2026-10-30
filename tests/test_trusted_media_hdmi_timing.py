"""Generated samples only: independent native timelines, no display or audio device."""
import time
import os
import unittest
from unittest.mock import MagicMock, patch

from services.trusted_media_service.hdmi_media_output import HdmiMediaOutput, KmsDevice
from services.trusted_media_service.gdp_media_ingress import _gstreamer
from services.trusted_media_service.media_progress import project_progress, validate_progress


class HdmiDiagnosticsTest(unittest.TestCase):
    def test_only_explicit_content_free_fields(self):
        projected = project_progress({}, {}, hdmi={
            'scheduleSkewMs': {'audio': -10}, 'initialCorrectionMs': {'audio': 90000},
            'pushedSamples': {'audio': 2}, 'secret': 'private', 'caps': 'private'})
        self.assertEqual(projected['hdmi']['audioScheduleSkewMs'], -10)
        self.assertEqual(projected['hdmi']['audioInitialCorrectionMs'], 90000)
        self.assertNotIn('private', str(projected))
        for key, value in (('audioPushed', -1), ('audioPushed', True), ('audioScheduleSkewMs', float('nan')),
                           ('unexpected', 1)):
            bad = {**projected, 'hdmi': {**projected['hdmi'], key: value}}
            with self.assertRaises(ValueError):
                validate_progress(bad)


class HdmiTimingTest(unittest.TestCase):
    def setUp(self):
        try:
            self.gst = _gstreamer()
        except ModuleNotFoundError as error:
            if error.name != 'gi' or os.environ.get('TEAMAIBOX_REQUIRE_MEDIA_INTEGRATION') == '1':
                raise
            self.skipTest('Legacy HDMI integration requires the Linux GStreamer test container; not a host unit test')
        self.output = HdmiMediaOutput(
            session_id='10000000-0000-4000-8000-000000000001',
            expires_at=time.time()+60, device=KmsDevice(card=1, connector='HDMI-A-1'))
        self.output._Gst = self.gst
        self.output._pipeline = MagicMock()
        self.output._pipeline.get_base_time.return_value = 0
        self.output._sources = {m: MagicMock() for m in ('audio', 'video')}
        for source in self.output._sources.values():
            source.emit.return_value = self.gst.FlowReturn.OK
            source.get_property.return_value = 0
        self.check = patch.object(self.output, '_check')
        self.check.start()
        self.addCleanup(self.check.stop)

    def push(self, media, pts_ms, now_ms, discont=False, segment_start_ms=0):
        Gst = self.gst
        caps = Gst.Caps.from_string(
            'audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved' if media == 'audio'
            else 'video/x-raw,format=I420,width=32,height=32,framerate=30/1')
        buf = Gst.Buffer.new_allocate(None, 1920 if media == 'audio' else 1536, None)
        buf.pts = pts_ms*Gst.MSECOND
        buf.duration = (10 if media == 'audio' else 33)*Gst.MSECOND
        if discont:
            buf.set_flags(Gst.BufferFlags.DISCONT)
        segment = Gst.Segment.new()
        segment.init(Gst.Format.TIME)
        segment.start = segment_start_ms*Gst.MSECOND
        self.output._pipeline.get_clock.return_value.get_time.return_value = now_ms*Gst.MSECOND
        self.output.push(media, Gst.Sample.new(buf, caps, segment, None))
        return self.output._sources[media].emit.call_args.args[1].pts // Gst.MSECOND

    def test_late_audio_independent_origin_not_scheduled_in_past(self):
        self.assertEqual(self.push('video', 30000, 100), 100)
        self.assertEqual(self.push('audio', 0, 500, True), 500)
        self.assertEqual(self.push('audio', 10, 510), 510)

    def test_independent_audio_origin_not_scheduled_minutes_in_future(self):
        self.push('video', 0, 100)
        self.assertEqual(self.push('audio', 90000, 500, True), 500)

    def test_normal_av_offset_preserved(self):
        self.push('video', 1000, 100)
        self.assertEqual(self.push('audio', 1030, 100, True), 130)

    def test_forward_audio_discontinuity_reanchors_without_moving_video(self):
        self.push('video', 1000, 100)
        self.push('audio', 1000, 100)
        self.assertEqual(self.push('audio', 20000, 140, True), 140)
        self.assertEqual(self.push('video', 1066, 166), 166)

    def test_backward_audio_discontinuity_does_not_move_video(self):
        self.push('video', 10000, 100)
        self.push('audio', 10000, 100)
        self.assertEqual(self.push('audio', 0, 140, True), 140)
        self.assertEqual(self.push('video', 10066, 166), 166)

    def test_video_discontinuity_does_not_move_audio(self):
        self.push('audio', 10000, 100)
        self.push('video', 10000, 100)
        self.assertEqual(self.push('video', 0, 140, True), 140)
        self.assertEqual(self.push('audio', 10050, 150), 150)

    def test_segment_running_time_conversion_retained(self):
        self.push('video', 1000, 100, segment_start_ms=1000)
        self.assertEqual(self.push('audio', 20030, 100, segment_start_ms=20000), 130)

    def test_real_gstreamer_renders_audio_with_independent_origin(self):
        # A real clock + synchronised sinks reproduces the scheduling failure
        # without opening /dev/dri or /dev/snd, or using sender media.
        Gst = self.gst
        pipeline = Gst.Pipeline.new(None)
        self.output._pipeline = pipeline
        for media in ('video', 'audio'):
            source = Gst.ElementFactory.make('appsrc')
            source.set_property('is-live', True)
            source.set_property('format', Gst.Format.TIME)
            sink = Gst.ElementFactory.make('fakesink')
            sink.set_property('sync', True)
            sink.set_property('async', False)
            pipeline.add(source); pipeline.add(sink)
            self.assertTrue(source.link(sink))
            self.output._sources[media] = source
            self.output._sinks[media] = sink
        try:
            self.assertNotEqual(pipeline.set_state(Gst.State.PLAYING), Gst.StateChangeReturn.FAILURE)
            for media, pts in (('video', 0), ('audio', 90000)):
                caps = Gst.Caps.from_string(
                    'audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved' if media == 'audio'
                    else 'video/x-raw,format=I420,width=32,height=32,framerate=30/1')
                buf = Gst.Buffer.new_allocate(None, 1920 if media == 'audio' else 1536, None)
                buf.pts = pts*Gst.MSECOND; buf.duration = 10*Gst.MSECOND
                self.output.push(media, Gst.Sample.new(buf, caps, None, None))
            deadline = time.monotonic()+1
            while time.monotonic() < deadline:
                if self.output._sinks['audio'].get_property('stats').get_value('rendered'):
                    break
                time.sleep(.01)
            self.assertGreater(self.output._sinks['audio'].get_property('stats').get_value('rendered'), 0)
        finally:
            pipeline.set_state(Gst.State.NULL)
            pipeline.get_state(Gst.SECOND)


if __name__ == '__main__':
    unittest.main()
