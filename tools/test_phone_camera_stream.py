"""Candidate transport tests only; never a substitute for guest acceptance."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]


def load(path):
    spec=importlib.util.spec_from_file_location('camera_test_subject',ROOT/path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


class CameraStreamTests(unittest.TestCase):
    def test_network_arguments_are_preserved(self):
        network=types.ModuleType('phone_network_base')
        original=['launch_cvd','--memory_mb=4096','--enable_tap_devices=true']
        network.network_launch_arguments=lambda config:list(original)
        with patch.dict(sys.modules,{'phone_network_base':network}):
            module=load('deploy/android/cuttlefish/phone_camera_stream_start.py')
            result=module.camera_arguments({'instance':21})
        self.assertEqual(result[:len(original)],original)
        self.assertIn('--camera=type=v4l2_emulated',result)
        self.assertEqual(len(result),len(original)+2)

    def test_crosvm_changes_only_camera_device(self):
        module=load('deploy/android/cuttlefish/phone_camera_crosvm.py')
        args=['run','--memory=4096','--simple-media-device','/kernel']
        converted,enabled=module.media_arguments(args)
        self.assertTrue(enabled)
        self.assertEqual(converted,['run','--memory=4096','--vhost-user=type=media,socket=/tmp/phone-camera-input/media.sock','/kernel'])
        self.assertIn('--simple-media-device',args)
        extended=['--extended-status',*args]
        converted,enabled=module.media_arguments(extended)
        self.assertTrue(enabled)
        self.assertEqual(converted,['--extended-status','run','--memory=4096','--vhost-user=type=media,socket=/tmp/phone-camera-input/media.sock','/kernel'])
        for original in ([],['run','/openwrt'],['stop','/phone/socket'],['--help']):
            converted,enabled=module.media_arguments(original)
            self.assertEqual(converted,original);self.assertFalse(enabled)
        for invalid in (['stop','--simple-media-device'],['--extended-status','stop','--simple-media-device'],['run','--simple-media-device','--simple-media-device']):
            with self.assertRaises(RuntimeError):module.media_arguments(invalid)

    def test_partial_download_is_strict(self):
        module=load('tools/phone_camera_package_stream.py')
        reply=b'HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-3/8\r\n\r\nABCD'
        with patch.object(module.subprocess,'run',return_value=subprocess.CompletedProcess([],0,reply,b'')):
            self.assertEqual(module.fetch_range('https://example.test/public',0,3,8,module.time.monotonic()+60),b'ABCD')
        for wrong in (reply.replace(b'0-3/8',b'4-7/8'),reply[:-1],reply.replace(b'206 Partial Content',b'200 OK')):
            with patch.object(module.subprocess,'run',return_value=subprocess.CompletedProcess([],0,wrong,b'')):
                with self.assertRaises(RuntimeError):module.fetch_range('https://example.test/public',0,3,8,module.time.monotonic()+60)

    def test_backend_is_not_a_host_install_or_user_migration(self):
        docker=(ROOT/'deploy/android/cuttlefish/CameraStreamCandidate.Dockerfile').read_text()
        self.assertIn('candidate-synthetic-stream-only',docker)
        self.assertNotIn('dpkg -i',docker)
        self.assertNotIn('apt-get',docker)
        self.assertNotIn('COPY crosvm',docker)
        self.assertIn('COPY camera-crosvm /opt/teamaibox/camera-host/bin/crosvm',docker)
        self.assertNotIn('COPY camera-crosvm /opt/cuttlefish',docker)
        wrapper=(ROOT/'deploy/android/cuttlefish/phone_camera_crosvm.py').read_text()
        self.assertIn("REAL = '/opt/teamaibox/camera-host/bin/crosvm'",wrapper)
        self.assertIn('os.getuid() != 10001',wrapper)
        self.assertIn('prctl(1, signal.SIGTERM',wrapper)


if __name__=='__main__':unittest.main()
