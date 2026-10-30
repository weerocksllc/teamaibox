"""Pure configuration/token checks; does not start or modify a VM."""
import base64
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'deploy/windows-arm64-crb/desktop_lab_gateway.py'
spec = importlib.util.spec_from_file_location('desktop_gateway', SOURCE)
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class DesktopLabTests(unittest.TestCase):
    def test_qmp_remove_accepts_real_success_text(self):
        with patch.object(gateway, 'run', return_value=json.dumps({'return': 'host forwarding rule for tcp:127.0.0.1:13389 removed\n'})):
            gateway.qmp('exact', 'hostfwd_remove net0 tcp:127.0.0.1:13389')

    def test_qmp_fail_closed(self):
        for reply in ({'error': {'desc': 'missing'}}, {'return': 'Could not set up host forwarding rule'}):
            with patch.object(gateway, 'run', return_value=json.dumps(reply)):
                with self.assertRaises(RuntimeError):
                    gateway.qmp('exact', 'hostfwd_add net0 tcp:127.0.0.1:13389-:3389')

    def test_no_public_bind_or_credential_configuration(self):
        text = SOURCE.read_text()
        self.assertNotIn("'ignore-cert'", text)
        self.assertNotIn("'password':", text)
        self.assertNotIn("'-p'", text)
        self.assertIn("'--memory-swap=1g'", text)
        self.assertIn("'--memory-swap=512m'", text)

    def test_official_json_auth_round_trip(self):
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
            from cryptography.hazmat.primitives.padding import PKCS7
        except ImportError:
            self.skipTest('cryptography is in the runtime container, not required on host')
        key = bytes(range(16))
        encrypted = base64.b64decode(gateway.token(key, now=1000))
        decryptor = Cipher(algorithms.AES(key), modes.CBC(bytes(16))).decryptor()
        padded = decryptor.update(encrypted) + decryptor.finalize()
        unpad = PKCS7(128).unpadder()
        signed = unpad.update(padded) + unpad.finalize()
        self.assertEqual(signed[:32], hmac.new(key, signed[32:], hashlib.sha256).digest())
        payload = json.loads(signed[32:])
        self.assertEqual(payload['expires'], 1300000)
        params = payload['connections']['Windows 11']['parameters']
        self.assertEqual(params['security'], 'nla')
        self.assertEqual(params['hostname'], '127.0.0.1')
        self.assertNotIn('password', params)
        self.assertEqual(params['cert-tofu'], 'true')
        self.assertEqual(len(payload['connections']), 1)


if __name__ == '__main__':
    unittest.main()
