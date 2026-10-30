"""Guest build works without an interactive user's home or Go cache."""
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from build_guest_tools import build


class GuestToolsEnvironmentTests(unittest.TestCase):
    def test_service_environment_has_private_build_caches(self):
        calls = []

        def compile_binary(args, **kwargs):
            env = kwargs['env']
            self.assertNotIn('HOME', env)
            self.assertTrue(Path(env['GOCACHE']).is_absolute())
            self.assertTrue(Path(env['GOPATH']).is_absolute())
            self.assertEqual((env['GOOS'], env['GOARCH']), ('linux', 'arm64'))
            calls.append(env['GOCACHE'])
            header = bytearray(20)
            header[:6] = b'\x7fELF\x02\x01'
            header[18:20] = struct.pack('<H', 183)
            Path(args[args.index('-o') + 1]).write_bytes(header)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            with patch.dict(os.environ, {'PATH': '/usr/bin'}, clear=True), \
                    patch('subprocess.run', side_effect=compile_binary):
                build(root, root / 'output')
            self.assertEqual(len(calls), 2)
            self.assertFalse(Path(calls[0]).parent.exists())
            self.assertEqual({p.name for p in (root / 'output').iterdir()},
                             {'phone-storage-helper', 'factory-worker-spec'})


if __name__ == '__main__':
    unittest.main()
