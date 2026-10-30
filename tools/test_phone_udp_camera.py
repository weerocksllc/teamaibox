"""Actual ARM64 GStreamer -> loopback UDP -> decoder tests; no Android claim."""
import hashlib
import socket
import sys
import threading
import time
import unittest
from unittest.mock import patch, Mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/android/cuttlefish'))
from phone_udp_camera import UdpCameraSource, parsed_format
from phone_udp_ingress import UdpPolicy
import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst
Gst.init(None)


def sender(target, *, width=320, height=240, rate=15, frames=36,
           pattern='ball', audio=False, codec='h264'):
    # Even tests use the same exact packet format. No files or external peers.
    mpeg2 = 'avenc_mpeg2video' if Gst.ElementFactory.find('avenc_mpeg2video') else 'mpeg2enc format=3'
    encoder = ('openh264enc multi-thread=1 bitrate=500000 gop-size=15 ! h264parse config-interval=-1'
               if codec == 'h264' else mpeg2+' ! mpegvideoparse')
    description = (f'mpegtsmux name=mux alignment=7 ! appsink name=out emit-signals=true sync=true '
                   f'videotestsrc is-live=true num-buffers={frames} pattern={pattern} ! '
                   f'video/x-raw,format=I420,width={width},height={height},framerate={rate}/1 ! '
                   f'{encoder} ! mux.')
    if audio:
        aac = 'avenc_aac' if Gst.ElementFactory.find('avenc_aac') else 'voaacenc'
        description += (' audiotestsrc is-live=true num-buffers=80 ! '
                        'audioconvert ! '+aac+' ! aacparse ! mux.')
    pipeline = Gst.parse_launch(description)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    def packet(sink):
        sample = sink.emit('pull-sample')
        if sample:
            buffer = sample.get_buffer()
            sock.sendto(buffer.extract_dup(0, buffer.get_size()), target)
        return Gst.FlowReturn.OK
    pipeline.get_by_name('out').connect('new-sample', packet)
    errors = []
    def transmit():
        try:
            assert pipeline.set_state(Gst.State.PLAYING) != Gst.StateChangeReturn.FAILURE
            message = pipeline.get_bus().timed_pop_filtered(10 * Gst.SECOND,
                       Gst.MessageType.ERROR | Gst.MessageType.EOS)
            assert message and message.type == Gst.MessageType.EOS, 'synthetic_sender_failed'
        except Exception as error:
            errors.append(str(error))
        finally:
            pipeline.set_state(Gst.State.NULL)
            sock.close()
    thread = threading.Thread(target=transmit)
    thread.start()
    return thread, errors


def rgb(jpeg):
    pipeline = Gst.parse_launch('appsrc name=input caps=image/jpeg ! jpegdec ! '
                               'videoconvert ! video/x-raw,format=RGB ! appsink name=out sync=false')
    try:
        pipeline.set_state(Gst.State.PLAYING)
        buffer = Gst.Buffer.new_allocate(None, len(jpeg), None)
        buffer.fill(0, jpeg)
        pipeline.get_by_name('input').emit('push-buffer', buffer)
        pipeline.get_by_name('input').emit('end-of-stream')
        sample = pipeline.get_by_name('out').emit('try-pull-sample', 2 * Gst.SECOND)
        assert sample
        data = sample.get_buffer()
        return data.extract_dup(0, data.get_size())
    finally:
        pipeline.set_state(Gst.State.NULL)


class UdpCameraTests(unittest.TestCase):
    def test_compressed_burst_uses_byte_budget_not_packet_count(self):
        source = UdpCameraSource.__new__(UdpCameraSource)
        source._push_lock = threading.Lock()
        source._stopped = threading.Event()
        source._first_packet = None
        source._queue_drops = source._queue_peak = 0
        source.Gst = Gst
        source._input = Mock()
        source._input.get_property.side_effect = lambda name: 131600 if name == 'current-level-bytes' else 100
        source._input.emit.return_value = Gst.FlowReturn.OK
        source._finish = Mock()
        source._packet(bytes(1316), 1)
        self.assertEqual(source._queue_drops, 0)
        source._input.emit.assert_called_once()
        source._finish.assert_not_called()
        source._input.get_property.return_value = 262144
        source._input.get_property.side_effect = None
        source._packet(bytes(1316), 2)
        self.assertEqual(source._queue_drops, 1)
        source._finish.assert_called_once_with('phone_camera_udp_buffer_overrun')
        self.assertEqual(source._input.emit.call_count, 1)

    def test_unknown_rate_and_resource_based_dimensions(self):
        self.assertEqual(parsed_format(640, 480, 0, 1)['frameRate'], None)
        self.assertEqual(parsed_format(640, 480, 30, 1)['frameRate'], [30, 1])
        self.assertEqual(parsed_format(2048, 64, 0, 1)['width'], 2048)
        self.assertEqual(parsed_format(640, 480, 120, 1)['frameRate'], [120, 1])
        for values in [(640,480,False,1),(640,480,0,0),(0,480,0,1),(2**31,480,0,1)]:
            with self.subTest(values=values), self.assertRaises(RuntimeError):
                parsed_format(*values)
        with patch('phone_video_camera.os.sysconf',return_value=1024):
            with self.assertRaisesRegex(RuntimeError,'memory_unavailable'):
                parsed_format(640,480,0,1)

    def setup_source(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(('127.0.0.1', 0))
        policy = UdpPolicy.from_admin(dict(listenAddress='127.0.0.1',
                   listenPort=sock.getsockname()[1], allowedSources=['127.0.0.1/32']))
        frames, ends = [], []
        source = UdpCameraSource(sock, policy, deliver=lambda *v: frames.append(v), on_end=ends.append)
        self.addCleanup(sock.close)
        self.addCleanup(source.close)
        return sock, source, frames, ends

    def transmit(self, sock, **kwargs):
        thread, errors = sender(sock.getsockname(), **kwargs)
        thread.join(12)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        time.sleep(.15)

    def test_real_ts_h264_is_dynamic_bounded_and_timestamped(self):
        sock, source, frames, ends = self.setup_source()
        self.transmit(sock)
        self.assertEqual(ends, [])
        self.assertGreaterEqual(len(frames), 15, source.status())
        self.assertGreaterEqual(len({hashlib.sha256(v[0]).digest() for v in frames}), 10)
        self.assertEqual([v[1] for v in frames], list(range(1, len(frames)+1)))
        self.assertEqual([v[2] for v in frames], sorted(v[2] for v in frames))
        self.assertGreater(frames[-1][2] - frames[0][2], 1_000_000_000)
        self.assertTrue(all(b[3] - a[3] >= 60_000_000 for a, b in zip(frames, frames[1:])))
        self.assertLessEqual(source.status()['queuePeakBytes'], 262144)
        # openh264enc does not signal the nominal rate in this TS stream's SPS.
        # Actual increasing PTS and delivery intervals above prove the timing.
        self.assertEqual(source.status()['input'], dict(width=320, height=240, frameRate=None))

    def test_receiver_waits_before_first_sender_then_decodes(self):
        sock, source, frames, ends = self.setup_source()
        time.sleep(3.2)
        self.assertEqual(source.status()['state'], 'waiting')
        self.assertEqual(ends, [])
        self.transmit(sock)
        self.assertGreaterEqual(len(frames), 15, source.status())

    def test_portrait_keeps_proportions_and_discards_audio(self):
        sock, source, frames, ends = self.setup_source()
        self.transmit(sock, width=160, height=320, pattern='red', audio=True)
        self.assertEqual(ends, [])
        self.assertGreaterEqual(len(frames), 15, source.status())
        pixels = rgb(frames[-1][0])
        red_width = sum(pixels[(240*640+x)*3] > 180 for x in range(640))
        self.assertTrue(236 <= red_width <= 244, red_width)
        self.assertTrue(all(v < 25 for v in pixels[(240*640+20)*3:(240*640+20)*3+3]))

    def test_stop_reclaims_socket_and_has_no_later_frame(self):
        sock, source, frames, ends = self.setup_source()
        self.transmit(sock, frames=18)
        self.assertGreaterEqual(len(frames), 8, source.status())
        source.close()
        count = len(frames)
        self.transmit(sock, frames=6)
        self.assertEqual(len(frames), count)
        self.assertEqual(ends, [])
        self.assertFalse(source._watch.is_alive())
        self.assertEqual(source.status()['retainedFrameBytes'], 0)
        self.assertEqual(source._ingress.socket.fileno(), -1)
        self.assertGreaterEqual(sock.fileno(), 0)

    def test_stream_end_stops_decoder_within_three_seconds(self):
        sock, source, frames, ends = self.setup_source()
        self.transmit(sock, frames=18)
        self.assertGreaterEqual(len(frames), 8, source.status())
        end = time.monotonic() + 3.5
        while not ends and time.monotonic() < end:
            time.sleep(.05)
        self.assertEqual(ends, ['phone_camera_udp_input_stalled'])
        self.assertEqual(source.status()['state'], 'stopped')
        self.assertFalse(source._ingress.thread.is_alive())
        self.assertEqual(source.status()['retainedFrameBytes'], 0)

    def test_framed_garbage_does_not_keep_empty_decoder_alive(self):
        sock, source, frames, ends = self.setup_source()
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as peer:
            end = time.monotonic() + 4
            while not ends and time.monotonic() < end:
                peer.sendto(b'\x47'+bytes(187), sock.getsockname())
                time.sleep(.1)
        self.assertEqual(frames, [])
        self.assertEqual(ends, ['phone_camera_udp_input_stalled'])

    def test_wrong_video_codec_never_reaches_camera(self):
        sock, source, frames, ends = self.setup_source()
        self.transmit(sock, codec='mpeg2', rate=30, frames=18)
        self.assertEqual(frames, [])
        self.assertEqual(ends, ['phone_camera_udp_format_unsupported'])

    def test_wide_stream_is_not_rejected_by_old_resolution_ceiling(self):
        sock, source, frames, ends = self.setup_source()
        self.transmit(sock, width=2048, height=64, frames=24)
        self.assertGreaterEqual(len(frames), 8, source.status())
        self.assertEqual(ends, [])

    def test_reconnect_uses_fresh_decoder_and_no_old_frames(self):
        sock, first, frames, ends = self.setup_source()
        self.transmit(sock, pattern='red', frames=18)
        first.close()
        policy = UdpPolicy.from_admin(dict(listenAddress='127.0.0.1',
                   listenPort=sock.getsockname()[1], allowedSources=['127.0.0.1/32']))
        fresh = []
        second = UdpCameraSource(sock, policy, deliver=lambda *v: fresh.append(v))
        self.addCleanup(second.close)
        self.assertEqual(fresh, [])
        self.transmit(sock, pattern='blue', frames=18)
        self.assertGreaterEqual(len(fresh), 8, second.status())
        pixels = rgb(fresh[-1][0])
        pixel = pixels[(240*640+320)*3:(240*640+320)*3+3]
        self.assertLess(pixel[0], 30)
        self.assertGreater(pixel[2], 220)
        self.assertEqual(fresh[0][1], 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
