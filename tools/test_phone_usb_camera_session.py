"""USB fd source/lifetime tests. Synthetic data, not physical acceptance."""
from pathlib import Path
import sys
import threading
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/android/cuttlefish'))
from phone_camera_input import CameraInput, CameraInputError
from phone_usb_camera_devices import UsbCameraError
from phone_usb_camera_fd_source import UsbCameraFdSource
from phone_usb_camera_session import UsbCameraSession, validate_start


class UsbSourceTests(unittest.TestCase):
    def setUp(self):
        self.authority = True
        self.fail_conversion = False
        self.deliveries = []
        self.readers = []
        self.converters = []
        outer = self
        class Reader:
            def __init__(self, fd, pixel):
                self.mode = dict(pixelFormat=pixel, width=800, height=600, frameRate=[30, 1])
                self.maps = [None] * 3
                self.closed = False
                self.number = 0
                outer.readers.append(self)
            def read(self, timeout=.1):
                if timeout == 0:
                    return None
                time.sleep(.01)
                self.number += 1
                return b'private-frame', self.number
            def close(self):
                self.closed = True
        class Converter:
            def __init__(self, mode):
                self.closed = False
                outer.converters.append(self)
            def convert(self, raw, pts, stopped):
                if outer.fail_conversion:
                    raise UsbCameraError('phone_camera_usb_capture_failed')
                return b'converted'
            def close(self):
                self.closed = True
        self.Reader, self.Converter = Reader, Converter
    def start(self):
        return UsbCameraFdSource(3, pixel_format='MJPG',
            deliver=lambda *frame: self.deliveries.append(frame), authorized=lambda: self.authority,
            reader_factory=self.Reader, converter_factory=self.Converter)
    def test_repeated_frames_and_stop_release_before_return(self):
        source = self.start()
        try:
            self.assertTrue(source.ready.is_set())
            self.assertGreater(source.frames, 0)
        finally:
            source.close()
        count = len(self.deliveries)
        time.sleep(.03)
        self.assertEqual(count, len(self.deliveries))
        self.assertTrue(self.readers[0].closed)
        self.assertTrue(self.converters[0].closed)
    def test_revocation_and_decoder_failure_release_device(self):
        for failure in ('revoke', 'decode'):
            with self.subTest(failure=failure):
                self.authority = True
                self.fail_conversion = False
                source = self.start()
                if failure == 'revoke': self.authority = False
                else: self.fail_conversion = True
                self.assertTrue(source.done.wait(1))
                source.close()
                self.assertTrue(self.readers[-1].closed)
                self.assertTrue(self.converters[-1].closed)
    def test_no_capture_without_authority(self):
        self.authority = False
        with self.assertRaisesRegex(UsbCameraError, 'permission_required'): self.start()
        self.assertFalse(self.readers)
    def test_initial_decode_failure_releases_device(self):
        self.fail_conversion = True
        with self.assertRaisesRegex(UsbCameraError, 'capture_failed'): self.start()
        self.assertTrue(self.readers[0].closed)
    def test_finite_backlog_keeps_newest_frame(self):
        base = self.Reader
        class Backlogged(base):
            def read(self, timeout=.1):
                if timeout == 0:
                    self.number += 1
                    return b'newer', self.number
                return super().read(timeout)
        self.Reader = Backlogged
        source = self.start()
        source.close()
        self.assertGreaterEqual(source.discarded, 3)
        self.assertEqual(self.deliveries[0][2], 4)


class UsbSessionTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.
        self.alive = True
        self.config = {k: str(uuid.uuid4()) for k in ('phoneId', 'ownerId', 'runId')}
        self.config['generation'] = 1
        self.grant = {**self.config, **{k: str(uuid.uuid4()) for k in ('id', 'sourceId', 'sessionId')}, 'sourceKind': 'usb'}
        self.value = {'grant': self.grant, 'pixelFormat': 'MJPG'}
        self.frame = (Path(__file__).parent / 'fixtures/phone-camera-checker-v1.jpg').read_bytes()
        self.input = CameraInput(self.config, self.frame, lambda: self.now, lambda: self.now)
        self.sources = []
        outer = self
        class Source:
            def __init__(self, fd, **options):
                self.closed = False
                self.options = options
                outer.sources.append(self)
                assert options['authorized']()
                options['deliver'](outer.frame, 1, 1)
            def close(self): self.closed = True
        self.factory = Source
    def start(self):
        return UsbCameraSession(self.value, self.config, 3, broker=self.input.apply,
            parent_alive=lambda: self.alive, factory=self.factory)
    def open(self):
        self.input.apply({'action': 'open', 'grant': self.grant, 'leaseExpiresAt': 104000})
    def test_no_capture_without_grant_or_for_foreign_phone(self):
        with self.assertRaises(CameraInputError): self.start()
        for patch in ({'phoneId': str(uuid.uuid4())}, {'generation': 2}, {'sourceKind': 'video'}):
            with self.assertRaises(CameraInputError):
                validate_start({**self.value, 'grant': {**self.grant, **patch}}, self.config)
        self.assertFalse(self.sources)
    def test_expiry_clears_frame_and_releases_camera(self):
        self.open()
        session = self.start()
        try:
            self.assertTrue(session.ready.is_set())
            self.now = 105
            self.assertTrue(session.done.wait(1))
            self.assertIsNone(self.input.active)
            self.assertTrue(self.sources[0].closed)
        finally: session.close()
    def test_parent_loss_clears_frame(self):
        self.open()
        session = self.start()
        self.alive = False
        self.assertTrue(session.done.wait(1))
        session.close()
        self.assertIsNone(self.input.active)
        self.assertTrue(self.sources[0].closed)
    def test_old_cleanup_does_not_close_new_source(self):
        self.open()
        session = self.start()
        session.close()
        new = {**self.grant, 'id': str(uuid.uuid4()), 'sourceId': str(uuid.uuid4()), 'sourceKind': 'image'}
        self.input.apply({'action': 'open', 'grant': new, 'leaseExpiresAt': 104000})
        self.input.apply({'action': 'frame', 'grant': new, 'sequence': 1}, self.frame)
        session.close()
        self.assertEqual(self.input.active['grant'], new)
    def test_device_path_and_format_injection_rejected(self):
        for value in ({**self.value, 'path': '/dev/video0'}, {**self.value, 'pixelFormat': 'MJPG ! filesink'}):
            with self.assertRaises(CameraInputError): validate_start(value, self.config)


if __name__ == '__main__': unittest.main()
