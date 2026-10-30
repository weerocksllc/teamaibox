"""Actual GStreamer ingress tests; run in the Python/GDP ARM64 candidate.

Generated moving test patterns/tones only; no Apple or HDMI/SFU acceptance.
"""
import importlib.util
import os
import subprocess
import tempfile
import time
import unittest

from services.trusted_media_service.gdp_media_ingress import GdpMediaIngress, MediaIngressError

AVAILABLE = importlib.util.find_spec("gi") is not None


@unittest.skipUnless(AVAILABLE, "container Python/GStreamer GI runtime required")
class GdpIngressTest(unittest.TestCase):
    def setUp(self):
        self.video_read, self.video_write = os.pipe()
        self.audio_read, self.audio_write = os.pipe()
        self.processes = []
        self.ingress = GdpMediaIngress(video_fd=self.video_read, audio_fd=self.audio_read)

    def tearDown(self):
        self.ingress.close()
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=3)
        for fd in (self.video_read, self.video_write, self.audio_read, self.audio_write):
            try:
                os.close(fd)
            except OSError:
                pass

    def produce(self, media, caps, count=12, live=True):
        fd = self.video_write if media == "video" else self.audio_write
        source = "videotestsrc" if media == "video" else "audiotestsrc"
        process = subprocess.Popen(["gst-launch-1.0", "-q", source, f"num-buffers={count}",
            "is-live=" + str(live).lower(), "!", caps, "!", "gdppay", "!", "fdsink", "fd=1", "sync=false"],
            stdin=subprocess.DEVNULL, stdout=fd, stderr=subprocess.DEVNULL,
            close_fds=True)
        self.processes.append(process)
        return process

    def consume(self, media, count=1):
        received = 0
        deadline = time.monotonic() + 4
        while received < count and time.monotonic() < deadline:
            sample = self.ingress.pull(media, timeout_ms=50)
            if sample is not None:
                self.assertGreater(sample.get_buffer().get_size(), 0)
                received += 1
                sample = None
        self.assertEqual(received, count)

    def test_real_landscape_and_audio_are_separate_received_events(self):
        before = self.ingress.snapshot()
        self.assertFalse(before["tracks"]["video"]["recentInput"])
        self.produce("video", "video/x-raw,format=I420,width=1920,height=1080,framerate=30/1", count=120)
        self.produce("audio", "audio/x-raw,format=S16LE,rate=48000,channels=2", count=200)
        # Poll both live tracks fairly. Sequential consumption can intentionally
        # drop the entire short audio burst behind the two-sample queue limit.
        received = {"video": 0, "audio": 0}
        deadline = time.monotonic() + 4
        while min(received.values()) < 4 and time.monotonic() < deadline:
            for media in received:
                sample = self.ingress.pull(media, timeout_ms=25)
                if sample is not None:
                    self.assertGreater(sample.get_buffer().get_size(), 0)
                    received[media] += 1
                    sample = None
        self.assertGreaterEqual(min(received.values()), 4)
        facts = self.ingress.snapshot()
        self.assertTrue(facts["tracks"]["video"]["recentInput"])
        self.assertTrue(facts["tracks"]["audio"]["recentInput"])
        self.assertFalse(facts["outputsValidated"])
        self.assertEqual(facts["tracks"]["video"]["caps"]["width"], 1920)
        self.assertEqual(facts["tracks"]["audio"]["caps"]["rate"], 48000)

    def test_portrait_frames_remain_in_baseline_envelope(self):
        self.produce("video", "video/x-raw,format=NV12,width=1080,height=1920,framerate=30/1")
        self.consume("video", 3)
        facts = self.ingress.snapshot()["tracks"]["video"]
        self.assertEqual(facts["caps"]["height"], 1920)

    def test_slow_consumer_cannot_block_or_queue_all_frames(self):
        process = self.produce("video", "video/x-raw,format=I420,width=320,height=240,framerate=30/1",
                               count=200, live=False)
        self.assertEqual(process.wait(timeout=4), 0)
        consumed = 0
        for _ in range(4):
            if self.ingress.pull("video", timeout_ms=50) is not None:
                consumed += 1
        self.assertGreater(consumed, 0)
        self.assertLessEqual(consumed, 2)
        self.assertEqual(self.ingress.snapshot()["maximumQueuedSamples"], {"video": 2, "audio": 32})

    def test_short_empty_stream_is_never_media_ready(self):
        os.write(self.video_write, b"not-a-gdp-packet")
        os.close(self.video_write)
        for _ in range(5):
            self.assertIsNone(self.ingress.pull("video", timeout_ms=50))
        facts = self.ingress.snapshot()["tracks"]["video"]
        self.assertEqual(facts["receivedFrames"], 0)
        self.assertFalse(facts["recentInput"])

    def test_audio_decode_bursts_keep_every_short_pcm_buffer(self):
        Gst = self.ingress._Gst
        pipeline = Gst.parse_launch('appsrc name=feed is-live=true format=time ! gdppay ! fdsink sync=false fd='+str(self.audio_write))
        feed = pipeline.get_by_name('feed')
        feed.set_property('caps', Gst.Caps.from_string('audio/x-raw,format=S16LE,rate=44100,channels=2,layout=interleaved'))
        pipeline.set_state(Gst.State.PLAYING)
        sent = received = 0
        frame_ns = 352 * Gst.SECOND // 44100
        next_burst = time.monotonic()
        try:
            while sent < 160 or time.monotonic() < next_burst + .15:
                if sent < 160 and time.monotonic() >= next_burst:
                    for _ in range(4):
                        buffer = Gst.Buffer.new_allocate(None, 352*4, None)
                        buffer.memset(0, 0, buffer.get_size())
                        buffer.pts, buffer.duration = sent*frame_ns, frame_ns
                        self.assertEqual(feed.emit('push-buffer', buffer), Gst.FlowReturn.OK)
                        sent += 1
                    next_burst += 4 * frame_ns / Gst.SECOND
                for _ in range(2):
                    if self.ingress.pull('audio', timeout_ms=0) is None:
                        break
                    received += 1
                time.sleep(.005)
            self.assertEqual(received, sent)
            facts = self.ingress.snapshot()
            self.assertEqual(facts['tracks']['audio']['observedFrames'], sent)
            self.assertEqual(facts['tracks']['audio']['timestampDiscarded'], 0)
            self.assertEqual(facts['maximumQueuedSamples'], {'video': 2, 'audio': 32})
        finally:
            self.ingress.close()
            pipeline.set_state(Gst.State.NULL)

    def test_bad_video_does_not_stop_valid_audio(self):
        self.produce("video", "video/x-raw,format=I420,width=3840,height=2160,framerate=30/1")
        self.produce("audio", "audio/x-raw,format=S16LE,rate=44100,channels=1", count=50)
        with self.assertRaises(MediaIngressError):
            self.consume("video")
        self.consume("audio", 2)
        facts = self.ingress.snapshot()
        self.assertEqual(facts["tracks"]["video"]["state"], "failed")
        self.assertTrue(facts["tracks"]["audio"]["recentInput"])

    def test_close_is_idempotent_with_no_source_and_preserves_caller_fds(self):
        started = time.monotonic()
        self.ingress.close()
        self.ingress.close()
        self.assertLess(time.monotonic() - started, 1)
        os.fstat(self.video_read)
        os.fstat(self.audio_read)
        self.assertTrue(self.ingress.snapshot()["closed"])
        with self.assertRaises(MediaIngressError):
            self.ingress.pull("video")

    def test_regular_file_and_write_pipe_are_not_accepted(self):
        fd = os.open("/dev/null", os.O_RDONLY)
        try:
            for invalid in (fd, self.video_write, self.audio_read):
                with self.assertRaises(MediaIngressError):
                    GdpMediaIngress(video_fd=invalid, audio_fd=self.audio_read)
        finally:
            os.close(fd)

    def test_named_pipe_is_not_an_anonymous_native_receiver_descriptor(self):
        with tempfile.TemporaryDirectory() as directory:
            path = directory + "/named.fifo"
            os.mkfifo(path, 0o600)
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            try:
                with self.assertRaises(MediaIngressError):
                    GdpMediaIngress(video_fd=fd, audio_fd=self.audio_read)
            finally:
                os.close(fd)


if __name__ == "__main__":
    unittest.main()
