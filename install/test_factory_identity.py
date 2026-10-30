import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

from factory_bootstrap import expand, pool_identity, variables
from factory_identity import secret_file, tls_identity, install_tls_copies
from offline_common import InstallError, read_json


class IdentityTests(unittest.TestCase):
    def test_pool_identity_matches_guest_helper_contract(self):
        identity = '12345678-1234-4234-8234-123456789abc'
        value = pool_identity(identity)
        self.assertRegex(value, r'^[a-z][a-z0-9_.-]{2,127}$')
        self.assertEqual(value, pool_identity(identity))
        values = variables(Path('/test'), dict(installationId=identity, nodeId=identity),
                           dict(releaseId='test', images=[], assets=[]))
        self.assertEqual(values['ID.pool'], value)

    def test_role_tokens_and_numeric_values_are_not_strings(self):
        values = {'IMAGE.phone-runtime': 'sha256:abc', 'KVM_GID': 108,
                  'CPU_GROUPS': [[0, 2], [1, 3]], 'DATA': '/local/data'}
        value = expand({'image': '@@IMAGE.phone-runtime@@', 'group': '@@KVM_GID@@',
                        'cpu': '@@CPU_GROUPS@@', 'path': '@@DATA@@/volumes'}, values)
        self.assertEqual(value, dict(image='sha256:abc', group=108, cpu=[[0, 2], [1, 3]], path='/local/data/volumes'))
        value['cpu'].append([4])
        self.assertEqual(len(values['CPU_GROUPS']), 2)
        for invalid in ('@@IMAGE.missing@@', '@@bad token@@'):
            with self.subTest(invalid=invalid), self.assertRaises(InstallError):
                expand(invalid, values)

    def test_command_secret_uses_standard_base64_and_reuses_factor(self):
        with tempfile.TemporaryDirectory() as temporary:
            row = dict(name='command', path='secrets/command', format='base64', bytes=32,
                       uid=os.geteuid(), gid=os.getegid())
            path = secret_file(row, Path(temporary))
            raw, inode = path.read_bytes(), path.stat().st_ino
            self.assertEqual(len(base64.b64decode(raw, validate=True)), 32)
            self.assertTrue(raw.endswith(b'='))
            secret_file(row, Path(temporary))
            self.assertEqual((raw, inode), (path.read_bytes(), path.stat().st_ino))
            path.chmod(0o644)
            with self.assertRaises(InstallError):
                secret_file(row, Path(temporary))

    def test_two_installations_get_independent_ca_and_node_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            nodes = [str(uuid.uuid4()), str(uuid.uuid4())]
            installs = [str(uuid.uuid4()), str(uuid.uuid4())]
            for i in range(2):
                directory = root / str(i)
                tls_identity(directory, nodes[i], installs[i])
                before = {p.name: p.read_bytes() for p in directory.iterdir()}
                tls_identity(directory, nodes[i], installs[i])
                self.assertEqual(before, {p.name: p.read_bytes() for p in directory.iterdir()})
                cert = subprocess.check_output(['openssl', 'x509', '-in', str(directory / 'node.crt'), '-text', '-noout'], text=True)
                self.assertIn('URI:spiffe://teamaibox.local/node/' + nodes[i], cert)
                self.assertIn('DNS:localhost', cert)
                self.assertEqual((directory / 'ca.key').stat().st_mode & 0o777, 0o600)
            self.assertNotEqual((root / '0/ca.crt').read_bytes(), (root / '1/ca.crt').read_bytes())
            with self.assertRaises(InstallError):
                tls_identity(root / '0', nodes[1], installs[1])

    def test_partial_existing_identity_not_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'ca.key').write_text('existing private material')
            with self.assertRaises(InstallError):
                tls_identity(root, str(uuid.uuid4()), str(uuid.uuid4()))
            self.assertEqual((root / 'ca.key').read_text(), 'existing private material')

    def test_private_ca_cannot_be_copied_to_service(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(InstallError):
                install_tls_copies([dict(source='ca.key', path='public/ca.key')], Path(temporary), Path(temporary))


if __name__ == '__main__':
    unittest.main()
