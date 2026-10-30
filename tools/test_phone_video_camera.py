"""Linux/GStreamer codec tests. Synthetic media only; no Android claim."""
import fcntl
import hashlib
import os
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/android/cuttlefish'))
from phone_video_camera import (MAX_INPUT, VideoCameraError, VideoCameraSource,
                                sealed_input, source_format)
from phone_video_camera_session import VideoCameraSession, validate_start
from phone_camera_input import CameraInput, CameraInputError
import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst
Gst.init(None)


def sealed(data, seal=True):
    fd = os.memfd_create('synthetic-camera-video', os.MFD_ALLOW_SEALING)
    os.write(fd, data)
    if seal:
        fcntl.fcntl(fd, fcntl.F_ADD_SEALS, fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW |
                    fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
    return fd


def generate(*, width=320, height=240, frames=24, rate=15, pattern='ball',
             audio=False, orientation=None, codec='h264'):
    # All generated files live on the test container's capped /tmp tmpfs.
    with tempfile.TemporaryDirectory(prefix='camera-video-') as directory:
        target = Path(directory) / 'synthetic.mp4'
        encoder = ('openh264enc multi-thread=1 bitrate=300000 ! h264parse' if codec == 'h264'
                   else 'avenc_mpeg4 ! mpeg4videoparse')
        description = (f'mp4mux name=mux ! filesink location={target} '
                       f'videotestsrc num-buffers={frames} pattern={pattern} ! '
                       f'video/x-raw,format=I420,width={width},height={height},framerate={rate}/1 ! '
                       f'{encoder} ! mux.')
        if audio:
            description += (' audiotestsrc num-buffers=16 wave=sine ! '
                            'audio/x-raw,format=S16LE,rate=48000,channels=1 ! '
                            'audioconvert ! avenc_aac ! aacparse ! mux.')
        pipeline = Gst.parse_launch(description)
        try:
            assert pipeline.set_state(Gst.State.PLAYING) != Gst.StateChangeReturn.FAILURE
            result = pipeline.get_bus().timed_pop_filtered(15 * Gst.SECOND,
                        Gst.MessageType.EOS | Gst.MessageType.ERROR)
            assert result and result.type == Gst.MessageType.EOS, 'synthetic_encoder_failed'
        finally:
            pipeline.set_state(Gst.State.NULL)
        value = target.read_bytes()
        # A real ISO BMFF track display matrix, not a pipeline-only TAG event.
        # This fixture has a single generated video track, no user input.
        if orientation:
            assert not audio and orientation == 'rotate-90'
            data = bytearray(value)
            def atoms(start, end):
                offset = start
                while offset + 8 <= end:
                    size = int.from_bytes(data[offset:offset+4], 'big')
                    assert 8 <= size <= end-offset
                    yield offset, size, bytes(data[offset+4:offset+8])
                    offset += size
            moov = next(v for v in atoms(0,len(data)) if v[2] == b'moov')
            trak = next(v for v in atoms(moov[0]+8,moov[0]+moov[1]) if v[2] == b'trak')
            tkhd = next(v for v in atoms(trak[0]+8,trak[0]+trak[1]) if v[2] == b'tkhd')
            offset = tkhd[0]+8
            assert data[offset] == 0
            data[offset+40:offset+76] = struct.pack('>9i',0,65536,0,-65536,0,0,height*65536,0,1<<30)
            value = bytes(data)
        return value


def rgb(jpeg):
    pipeline = Gst.parse_launch('appsrc name=input format=time caps=image/jpeg ! jpegdec ! '
                               'videoconvert ! video/x-raw,format=RGB ! '
                               'appsink name=output sync=false')
    try:
        pipeline.set_state(Gst.State.PLAYING)
        source = pipeline.get_by_name('input')
        buf = Gst.Buffer.new_allocate(None, len(jpeg), None)
        buf.fill(0, jpeg)
        source.emit('push-buffer', buf)
        source.emit('end-of-stream')
        sample = pipeline.get_by_name('output').emit('try-pull-sample', 2 * Gst.SECOND)
        assert sample, 'jpeg_readback_failed'
        buffer = sample.get_buffer()
        return buffer.extract_dup(0, buffer.get_size())
    finally:
        pipeline.set_state(Gst.State.NULL)


class VideoCamera(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.movie = generate()

    def test_mp4_demux_without_framerate_waits_for_parser_caps(self):
        class NoDemuxRate(VideoCameraSource):
            def _pad_added(self, demux, pad):
                caps = Gst.Caps.from_string('video/x-h264,width=320,height=240')
                class Pad:
                    def get_current_caps(self): return caps
                    def link(self, target): return pad.link(target)
                return super()._pad_added(demux, Pad())
        fd=sealed(self.movie);source=None;frames=[];ready=threading.Event()
        try:
            source=NoDemuxRate(fd,loop=False,deliver=lambda data,*args:(frames.append(data),ready.set()))
            self.assertTrue(ready.wait(3), 'valid MP4 rejected before parsed caps')
            self.assertEqual(source.input_format['frameRate'], [15, 1])
            self.assertGreater(len(frames[0]), 0)
        finally:
            if source:source.close()
            os.close(fd)

    def test_input_is_sealed_bounded_mp4_not_path_or_url(self):
        for invalid in ('/etc/passwd', 'https://example.invalid/a.mp4', -1, True):
            with self.subTest(value=invalid), self.assertRaises(VideoCameraError):
                sealed_input(invalid)
        for data, seal in ((self.movie, False), (b'not an mp4', True), (b'', True)):
            fd = sealed(data, seal)
            try:
                with self.assertRaises(VideoCameraError): sealed_input(fd)
            finally: os.close(fd)
        fd = os.memfd_create('synthetic-large', os.MFD_ALLOW_SEALING)
        try:
            os.write(fd, self.movie)
            os.ftruncate(fd, 80 * 1024**2)
            fcntl.fcntl(fd, fcntl.F_ADD_SEALS, 15)
            duplicate = sealed_input(fd)
            self.assertEqual(os.fstat(duplicate).st_size, 80 * 1024**2)
            os.close(duplicate)
        finally: os.close(fd)
        fd = sealed(self.movie)
        try:
            duplicate = sealed_input(fd)
            os.close(duplicate)
            self.assertEqual(os.pread(fd, 8, 0)[4:8], b'ftyp')
        finally: os.close(fd)

    def test_format_accepts_4k_high_rate_and_rejects_invalid_or_impossible_memory(self):
        self.assertEqual(source_format(1920,1080,30,1)['width'], 1920)
        self.assertEqual(source_format(3840,2160,60,1)['width'], 3840)
        self.assertEqual(source_format(320,240,120,1)['frameRate'], [120,1])
        for args in ((2**30,2**30,30,1),(0,100,30,1),
                     (320,240,30,0),(320,240,True,1),(320,240,0,1)):
            with self.subTest(args=args), self.assertRaises(VideoCameraError): source_format(*args)

    def playback(self, data, *, loop=False, seconds=5):
        frames, reasons, ended = [], [], threading.Event()
        fd = sealed(data)
        at = time.monotonic()
        def deliver(value, sequence, pts, iteration):
            frames.append((value, sequence, pts, iteration, time.monotonic()-at))
        def end(reason): reasons.append(reason); ended.set()
        source = None
        try:
            source = VideoCameraSource(fd, loop=loop, deliver=deliver, on_end=end)
            ended.wait(seconds)
            metadata = dict(input=source.input_format, duration=source.duration_ns)
        except VideoCameraError as error:
            reasons.append(str(error));metadata = {}
        finally:
            if source: source.close()
            os.close(fd)
        return frames, reasons, metadata

    def test_real_h264_dynamic_frames_paced_pts_and_end(self):
        frames, reasons, metadata = self.playback(self.movie)
        self.assertEqual(reasons, ['ended'])
        self.assertGreaterEqual(len(frames), 20)
        self.assertGreaterEqual(frames[-1][4]-frames[0][4], 1.3)
        self.assertGreater(len({hashlib.sha256(f[0]).digest() for f in frames}), 10)
        self.assertEqual([f[1] for f in frames], list(range(1,len(frames)+1)))
        self.assertEqual([f[2] for f in frames], sorted(f[2] for f in frames))
        self.assertTrue(all(f[3]==0 for f in frames))
        self.assertEqual(metadata['input']['frameRate'], [15,1])
        self.assertEqual(metadata['duration'], 1_600_000_000)

    def test_portrait_is_letterboxed_not_stretched(self):
        frames,reasons,_ = self.playback(generate(width=160,height=320,pattern='red',frames=6))
        self.assertEqual(reasons, ['ended'])
        pixels=rgb(frames[-1][0])
        def pixel(x,y): return pixels[(y*640+x)*3:(y*640+x)*3+3]
        self.assertTrue(all(v<20 for v in pixel(20,240)),pixel(20,240))
        self.assertGreater(pixel(320,240)[0],220)
        self.assertLess(pixel(320,240)[1],30)
        red_width=sum(pixel(x,240)[0]>180 for x in range(640))
        self.assertTrue(236<=red_width<=244,red_width)

    def test_loop_resets_media_pts_but_not_sequence(self):
        frames,reasons,_ = self.playback(generate(frames=9),loop=True,seconds=2)
        self.assertEqual(reasons, [])
        self.assertGreaterEqual(max(f[3] for f in frames),2)
        self.assertEqual([f[1] for f in frames],list(range(1,len(frames)+1)))
        for iteration in set(f[3] for f in frames):
            pts=[f[2] for f in frames if f[3]==iteration]
            self.assertEqual(pts,sorted(pts))
            self.assertLess(pts[0],100_000_000)

    def test_real_mp4_rotation_matrix_precedes_letterboxing(self):
        frames,reasons,_ = self.playback(generate(width=160,height=320,pattern='red',frames=6,orientation='rotate-90'))
        self.assertEqual(reasons,['ended'])
        pixels=rgb(frames[-1][0])
        red_width=sum(pixels[(240*640+x)*3]>180 for x in range(640))
        red_height=sum(pixels[(y*640+320)*3]>180 for y in range(480))
        self.assertEqual(red_width,640)
        self.assertTrue(316<=red_height<=324,red_height)

    def test_stop_closes_decoder_without_later_frames(self):
        frames=[];fd=sealed(self.movie)
        source=VideoCameraSource(fd,loop=True,deliver=lambda *frame:frames.append(frame))
        try:
            deadline=time.monotonic()+3
            while len(frames)<3 and time.monotonic()<deadline:time.sleep(.02)
            self.assertGreaterEqual(len(frames),3)
            source.close();count=len(frames);time.sleep(.2)
            self.assertEqual(len(frames),count)
            self.assertIsNone(source._fd)
            self.assertFalse(source._watch.is_alive())
        finally:source.close();os.close(fd)

    def test_audio_track_is_discarded_and_corruption_fails_closed(self):
        frames,reasons,_=self.playback(generate(audio=True,frames=12))
        self.assertEqual(reasons,['ended']);self.assertGreaterEqual(len(frames),10)
        frames,reasons,_=self.playback(b'\x00\x00\x00\x18ftypisom'+b'\0'*64)
        self.assertEqual(frames,[])
        self.assertEqual(len(reasons),1)
        self.assertTrue(reasons[0].startswith('phone_camera_video_'))

    def test_long_duration_starts_normally_without_waiting_ten_minutes(self):
        frames,reasons,metadata=self.playback(generate(width=32,height=32,frames=601,rate=1),seconds=2)
        self.assertGreater(len(frames),0)
        self.assertEqual(metadata['duration'],601*1_000_000_000)
        self.assertNotIn('phone_camera_video_duration_unsupported',reasons)

    def test_disk_backed_private_readonly_input(self):
        with tempfile.TemporaryFile() as file:
            file.write(self.movie);file.flush()
            readonly=os.open('/proc/self/fd/'+str(file.fileno()),os.O_RDONLY)
            try:
                duplicate=sealed_input(readonly);os.close(duplicate)
                with self.assertRaises(VideoCameraError):sealed_input(file.fileno())
            finally:os.close(readonly)

    def test_unsupported_video_codec_is_not_auto_selected(self):
        frames,reasons,_=self.playback(generate(frames=3,codec='mpeg4'))
        self.assertEqual(frames,[])
        self.assertEqual(reasons,['phone_camera_video_format_unsupported'])

    def test_ended_source_releases_pipeline_without_owner_close(self):
        fd=sealed(self.movie);ended=threading.Event()
        source=VideoCameraSource(fd,loop=False,deliver=lambda *_:None,on_end=lambda _:ended.set())
        try:
            self.assertTrue(ended.wait(4))
            self.assertEqual(source._pipeline.get_state(0)[1],Gst.State.NULL)
            self.assertIsNone(source._fd)
        finally:source.close();os.close(fd)

    def test_slow_video_is_not_rejected_or_sped_up(self):
        frames,reasons,_=self.playback(generate(frames=10,rate=5))
        self.assertEqual(reasons,['ended'])
        self.assertEqual(len(frames),10)
        self.assertGreater(frames[-1][4]-frames[0][4],1.7)

    def test_high_rate_input_is_reduced_to_fifteen_fps(self):
        frames,reasons,_=self.playback(generate(frames=60,rate=30))
        self.assertEqual(reasons,['ended'])
        self.assertTrue(28<=len(frames)<=31,len(frames))


class VideoLifetime(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.movie=generate(frames=15)
        frames,reasons,_=VideoCamera().playback(generate(frames=2,pattern='black'))
        assert reasons==['ended']
        cls.neutral=frames[0][0]

    def setUp(self):
        def uid(index):return '00000000-0000-4000-8000-'+str(index).zfill(12)
        self.config=dict(phoneId=uid(1),ownerId=uid(2),runId=uid(3),generation=1)
        self.grant={**self.config,'id':uid(4),'sourceId':uid(5),'sourceKind':'video','sessionId':uid(6)}
        self.broker=CameraInput(self.config,self.neutral)
        self.broker.apply(dict(action='open',grant=self.grant,leaseExpiresAt=time.time()*1000+4000))
        self.fd=sealed(self.movie)
        self.session=None

    def tearDown(self):
        if self.session:self.session.close()
        os.close(self.fd)

    def start(self,loop=True,parent_alive=lambda:True):
        self.session=VideoCameraSession(dict(grant=self.grant,loop=loop),self.config,self.fd,
                                       broker=self.broker.apply,parent_alive=parent_alive)
        self.assertTrue(self.session.ready.wait(3))
        return self.session

    def assert_stopped(self):
        self.assertTrue(self.session.done.wait(2))
        state=self.broker.apply(dict(action='status',grant=self.grant))
        self.assertEqual(state['state'],'stopped')
        self.assertEqual(state['retainedFrameBytes'],0)
        self.assertEqual(self.broker.current(),self.neutral)
        self.assertIsNone(self.session.source)

    def test_revoke_stops_native_input_and_clears_private_frame(self):
        self.start()
        self.broker.apply(dict(action='close',grant=self.grant))
        self.assert_stopped()

    def test_end_clears_frame_without_a_viewer(self):
        self.start(loop=False)
        self.assert_stopped()
        self.assertEqual(self.session.reason,'ended')

    def test_expiry_cannot_be_renewed_by_video_worker(self):
        self.start()
        with self.broker.lock:self.broker.active['deadline']=time.monotonic()+.1
        self.assert_stopped()

    def test_supervisor_loss_stops_source(self):
        alive=threading.Event();alive.set()
        self.start(parent_alive=alive.is_set)
        alive.clear()
        self.assert_stopped()

    def test_late_stop_cannot_revoke_new_image_source(self):
        self.start()
        self.broker.apply(dict(action='close',grant=self.grant))
        newer={**self.grant,'id':'00000000-0000-4000-8000-000000000007',
               'sourceId':'00000000-0000-4000-8000-000000000008','sourceKind':'image'}
        self.broker.apply(dict(action='open',grant=newer,leaseExpiresAt=time.time()*1000+4000))
        self.session.close()
        self.assertEqual(self.broker.apply(dict(action='status',grant=newer))['state'],'waiting')

    def test_owner_run_kind_and_loop_rejected_before_decoder(self):
        for grant in ({**self.grant,'ownerId':self.grant['phoneId']},
                      {**self.grant,'runId':self.grant['phoneId']},
                      {**self.grant,'generation':2},{**self.grant,'sourceKind':'browser'}):
            with self.subTest(grant=grant),self.assertRaises(CameraInputError):
                validate_start(dict(grant=grant,loop=False),self.config)
        with self.assertRaises(CameraInputError):validate_start(dict(grant=self.grant,loop='yes'),self.config)


if __name__=='__main__':unittest.main(verbosity=2)
