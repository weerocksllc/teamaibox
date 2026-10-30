"""Offline safety checks; these do not claim Camera2 guest acceptance."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]


class CameraCandidateTests(unittest.TestCase):
    def test_camera_flag_preserves_network_recipe(self):
        base=types.ModuleType('phone_network_base')
        args=['/opt/cuttlefish/bin/launch_cvd','--vsock_guest_cid=2121','--enable_tap_devices=true']
        base.network_launch_arguments=lambda config:list(args)
        with patch.dict(sys.modules,{'phone_network_base':base}):
            spec=importlib.util.spec_from_file_location('camera_candidate',ROOT/'deploy/android/cuttlefish/phone_camera_start.py')
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            actual=base.network_launch_arguments({'instance':21})
        self.assertEqual(actual,args+['--camera_server_port=7600'])
        self.assertEqual(len(args),3)

    def test_fixture_has_no_microphone_or_network_permission(self):
        from xml.etree import ElementTree as ET
        root=ET.parse(ROOT/'tools/fixtures/phone-camera-app/AndroidManifest.xml').getroot()
        permissions=[e.attrib['{http://schemas.android.com/apk/res/android}name'] for e in root.findall('uses-permission')]
        self.assertEqual(permissions,['android.permission.CAMERA'])

    def test_candidate_is_not_admitted_to_product(self):
        dockerfile=(ROOT/'deploy/android/cuttlefish/CameraCandidate.Dockerfile').read_text()
        self.assertIn('candidate-synthetic-only',dockerfile)
        self.assertIn('test-camera.apk',dockerfile)
        for path in ('services/scheduler/src/phone-rom.mjs','deploy/android/cuttlefish/phone_runtime.py'):
            self.assertNotIn('test-camera.apk',(ROOT/path).read_text())

    def test_qualifier_requires_guest_photo_not_source_jpeg(self):
        source=(ROOT/'tools/qualify_phone_camera_hal.py').read_text()
        self.assertIn("g['jpegCaptured']",source)
        self.assertIn("('previewY','photoRgb')",source)
        self.assertIn("r['browserAccepted'] is False",source)
        self.assertIn("'MemorySwap']==6*1024**3",source)


if __name__=='__main__':unittest.main()
