"""Synthetic timestamp faults through real GDP pipes and the production supervisor."""
import importlib.util
import os
import time
import unittest
from datetime import datetime, timezone
from services.trusted_media_service.gdp_media_ingress import GdpMediaIngress, _gstreamer
from services.trusted_media_service.receiver_supervisor import PairedReceiverSupervisor
from services.trusted_media_service.runtime_api import PRIVACY_POLICY
from tests.test_trusted_media_receiver_supervisor import Callback, Receiver, Output, SOURCE, SESSION


@unittest.skipUnless(importlib.util.find_spec('gi'), 'container GStreamer required')
class TimestampContinuityTest(unittest.TestCase):
    def setUp(self):
        self.Gst = _gstreamer()
        self.vr, self.vw = os.pipe(); self.ar, self.aw = os.pipe()
        self.ingress = GdpMediaIngress(video_fd=self.vr, audio_fd=self.ar)
        self.producers = []
        self.owner = None

    def tearDown(self):
        if self.owner is not None: self.owner()
        self.ingress.close()
        for pipeline in self.producers: pipeline.set_state(self.Gst.State.NULL)
        for fd in (self.vr, self.vw, self.ar, self.aw): os.close(fd)

    def sample(self, pts, media='video', discont=False, segment=None):
        Gst = self.Gst
        caps = Gst.Caps.from_string('video/x-raw,format=I420,width=320,height=240,framerate=30/1'
            if media == 'video' else 'audio/x-raw,format=S16LE,rate=44100,channels=2,layout=interleaved')
        buffer = Gst.Buffer.new_allocate(None, 320*240*3//2 if media == 'video' else 352*4, None)
        buffer.memset(0, 0, buffer.get_size()); buffer.pts = pts
        if discont: buffer.set_flags(Gst.BufferFlags.DISCONT)
        if segment is None:
            segment = Gst.Segment.new(); segment.init(Gst.Format.TIME)
        return Gst.Sample.new(buffer, caps, segment, None)

    def validate_sample(self, sample, media='video'):
        return self.ingress._validated_sample(media, sample, self.ingress._tracks[media])

    def test_duplicate_late_and_missing_frames_do_not_kill_either_track(self):
        Gst = self.Gst
        for media in ('video', 'audio'):
            self.assertIsNotNone(self.validate_sample(self.sample(Gst.SECOND, media), media))
            for pts in (Gst.SECOND, Gst.SECOND-10*Gst.MSECOND, Gst.CLOCK_TIME_NONE):
                self.assertIsNone(self.validate_sample(self.sample(pts, media), media))
            self.assertIsNotNone(self.validate_sample(self.sample(Gst.SECOND+Gst.MSECOND, media), media))
            self.assertEqual(self.ingress.snapshot()['tracks'][media]['receivedFrames'], 2)

    def test_raw_timestamp_rewind_in_new_segment_keeps_running_time(self):
        Gst = self.Gst
        self.validate_sample(self.sample(5*Gst.SECOND))
        segment = Gst.Segment.new(); segment.init(Gst.Format.TIME)
        segment.start = 0; segment.base = 6*Gst.SECOND
        value = self.validate_sample(self.sample(Gst.SECOND, segment=segment))
        self.assertEqual(value.get_buffer().pts, 7*Gst.SECOND)
        self.assertEqual(value.get_segment().to_running_time(Gst.Format.TIME, value.get_buffer().pts), 7*Gst.SECOND)

    def test_lost_discont_on_backward_and_forward_clock_steps_is_recovered(self):
        Gst = self.Gst
        self.validate_sample(self.sample(10*Gst.SECOND))
        for pts in (Gst.SECOND, 40*Gst.SECOND):
            value = self.validate_sample(self.sample(pts))
            self.assertTrue(value.get_buffer().has_flags(Gst.BufferFlags.DISCONT))
            self.assertEqual(value.get_buffer().pts, pts)

    def test_out_of_segment_sample_is_dropped_not_forwarded(self):
        Gst = self.Gst
        segment = Gst.Segment.new(); segment.init(Gst.Format.TIME); segment.start = 5*Gst.SECOND
        self.assertIsNone(self.validate_sample(self.sample(Gst.SECOND, segment=segment)))
        self.assertEqual(self.ingress.snapshot()['tracks']['video']['receivedFrames'], 0)

    def test_real_gdp_timestamp_faults_do_not_close_supervisor_or_other_track(self):
        Gst = self.Gst; self.ingress.close()
        events=[]; receiver=Receiver(events); receiver.paired=SOURCE
        receiver.duplicate_media_readers=lambda:(os.dup(self.vr),os.dup(self.ar))
        output=Output(events,'browser')
        supervisor=PairedReceiverSupervisor(callback_client=Callback(),
            output_factories={'browser':lambda **kw:output},receiver_factory=lambda:receiver)
        self.owner=lambda:supervisor.stop({'sessionId':SESSION})
        supervisor.start({'sessionId':SESSION,'receiverName':'Team-AI-0123456789','pairingPin':'1234',
            'outputSinks':['browser'],'browserStartsMuted':False,'mediaPrivacyPolicy':dict(PRIVACY_POLICY),
            'expiresAt':datetime.fromtimestamp(time.time()+20,timezone.utc).isoformat()})
        sources={}
        for media,fd in (('video',self.vw),('audio',self.aw)):
            pipeline=Gst.parse_launch('appsrc name=feed is-live=true format=time ! gdppay ! fdsink sync=false fd='+str(fd))
            sources[media]=pipeline.get_by_name('feed');sources[media].set_property('caps',self.sample(0,media).get_caps())
            self.producers.append(pipeline);pipeline.set_state(Gst.State.PLAYING)
        for i,pts in enumerate((Gst.SECOND, Gst.SECOND, Gst.CLOCK_TIME_NONE,
                Gst.SECOND-10*Gst.MSECOND, 2*Gst.SECOND, 0, Gst.MSECOND, 40*Gst.SECOND,
                40*Gst.SECOND+Gst.MSECOND)):
            for media in ('video','audio'):
                sample=self.sample(pts if media=='video' else (i+1)*20*Gst.MSECOND,media)
                self.assertEqual(sources[media].emit('push-buffer',sample.get_buffer()),Gst.FlowReturn.OK)
            time.sleep(.04)
        deadline=time.monotonic()+2
        while output.received.count('audio')<9 and time.monotonic()<deadline:time.sleep(.01)
        health=supervisor.health(SESSION)
        self.assertNotEqual(health.get('receiverState'),'failed')
        self.assertGreaterEqual(output.received.count('video'),5)
        self.assertEqual(output.received.count('audio'),9)
        self.assertIsNone(supervisor._last_failure)

