"""Synthetic small-packet audio and repeated GDP stream continuity tests."""
import importlib.util
import os
import subprocess
import time
import unittest
from datetime import datetime, timezone

from services.trusted_media_service.gdp_media_ingress import GdpMediaIngress
from services.trusted_media_service.receiver_supervisor import PairedReceiverSupervisor
from services.trusted_media_service.runtime_api import PRIVACY_POLICY
from tests.test_trusted_media_receiver_supervisor import Callback, Receiver, Output, SOURCE, SESSION


@unittest.skipUnless(importlib.util.find_spec('gi'), 'container GStreamer required')
class MediaContinuityTest(unittest.TestCase):
    def setUp(self):
        self.vr, self.vw = os.pipe()
        self.ar, self.aw = os.pipe()
        self.processes = []
        self.owned = None

    def tearDown(self):
        if self.owned is not None:
            self.owned()
        for p in self.processes:
            if p.poll() is None:
                p.terminate()
            p.wait(timeout=3)
        for fd in (self.vr, self.vw, self.ar, self.aw):
            os.close(fd)

    def produce(self, media, count):
        params = (['audiotestsrc', 'samplesperbuffer=352', 'wave=sine',
                   '!', 'audio/x-raw,format=S16LE,rate=44100,channels=2'] if media == 'audio' else
                  ['videotestsrc', 'pattern=ball', '!',
                   'video/x-raw,format=I420,width=320,height=240,framerate=30/1'])
        params[1:1] = ['is-live=true', 'num-buffers=' + str(count)]
        p = subprocess.Popen(['gst-launch-1.0', '-q', *params, '!', 'gdppay', '!',
                              'fdsink', 'fd=1', 'sync=false'],
            stdin=subprocess.DEVNULL, stdout=self.aw if media == 'audio' else self.vw,
            stderr=subprocess.DEVNULL, close_fds=True)
        self.processes.append(p)
        return p

    def test_small_audio_packets_are_not_dropped_while_video_is_idle(self):
        events = []
        receiver = Receiver(events)
        receiver.duplicate_media_readers = lambda: (os.dup(self.vr), os.dup(self.ar))
        receiver.paired = SOURCE
        output = Output(events, 'browser')
        supervisor = PairedReceiverSupervisor(callback_client=Callback(),
            output_factories={'browser': lambda **kw: output}, receiver_factory=lambda: receiver)
        self.owned = lambda: supervisor.stop({'sessionId': SESSION})
        supervisor.start({'sessionId': SESSION, 'receiverName': 'Team-AI-0123456789',
            'pairingPin': '1234', 'outputSinks': ['browser'], 'browserStartsMuted': False,
            'mediaPrivacyPolicy': dict(PRIVACY_POLICY),
            'expiresAt': datetime.fromtimestamp(time.time()+30, timezone.utc).isoformat()})
        p = self.produce('audio', 500)
        self.assertEqual(p.wait(timeout=8), 0)
        time.sleep(0.1)
        received = output.received.count('audio')
        print(f'synthetic_audio_packets={received}/500', flush=True)
        self.assertGreaterEqual(received, 490, f'only {received}/500 audio packets delivered')
        self.assertEqual(output.received.count('video'), 0)

    def test_second_video_stream_after_eos_is_received(self):
        ingress = GdpMediaIngress(video_fd=self.vr, audio_fd=self.ar)
        self.owned = ingress.close
        counts = []
        for cycle in range(2):
            p = self.produce('video', 10)
            count = 0
            deadline = time.monotonic()+2
            while time.monotonic() < deadline:
                sample = ingress.pull('video', timeout_ms=10)
                if sample is not None:
                    count += 1
                if p.poll() is not None and count >= 8:
                    break
            self.assertEqual(p.poll(), 0)
            for _ in range(10):
                ingress.pull('video', timeout_ms=10)
            counts.append(count)
        self.assertGreaterEqual(min(counts), 8, f'video packets by stream: {counts}')


class MediaProgressTest(unittest.TestCase):
    def test_owned_listener_can_rebind_after_close_but_not_share_a_live_port(self):
        import socket
        import socketserver
        from services.trusted_media_service.tls_runtime_server import TrustedMediaTlsServer
        from services.trusted_media_runtime.sfu_gateway import PrivateSfuGateway
        for production in (TrustedMediaTlsServer, PrivateSfuGateway):
            class Probe(socketserver.TCPServer):
                allow_reuse_address = production.allow_reuse_address
                allow_reuse_port = production.allow_reuse_port
            self.assertFalse(Probe.allow_reuse_port)
            server = Probe(('127.0.0.1', 0), socketserver.BaseRequestHandler)
            address = server.server_address
            with self.assertRaises(OSError):
                Probe(address, socketserver.BaseRequestHandler)
            client = socket.create_connection(address, timeout=1)
            peer, _ = server.socket.accept()
            peer.shutdown(socket.SHUT_WR)
            peer.close()
            self.assertEqual(client.recv(1), b'')
            client.close()
            server.server_close()
            successor = Probe(address, socketserver.BaseRequestHandler)
            successor.server_close()

    def test_only_explicit_counts_and_states_cross_private_health_boundary(self):
        from services.trusted_media_service.media_progress import project_progress, validate_progress
        v = project_progress({'private': 'secret', 'tracks': {'video': {'state': 'receiving',
            'receivedFrames': 10, 'caps': {'private': 'ignored'}}}},
            {'state': 'waiting', 'pushedSamples': {'video': 10}, 'url': 'private'})
        self.assertEqual(v['videoReceived'], 10)
        self.assertNotIn('private', str(v))
        for bad in ({**v, 'token': 'private'}, {**v, 'videoReceived': -1},
                    {**v, 'videoReceived': True}, {**v, 'browserState': 'private detail'}):
            with self.assertRaises(ValueError):
                validate_progress(bad)


if __name__ == '__main__':
    unittest.main()
