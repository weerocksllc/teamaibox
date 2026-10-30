"""Build-input unit tests; these do not assert Android camera compatibility."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import phone_camera_cargo_inputs as inputs


class CargoInputsTests(unittest.TestCase):
    def test_registry_names_are_not_paths(self):
        self.assertEqual(inputs.index_key('nix'), '3/n/nix')
        self.assertEqual(inputs.index_key('v4l2r'), 'v4/l2/v4l2r')
        for name in ('../secret', '/tmp/input', 'name?token=x', 'UPPER', ''):
            with self.assertRaises(RuntimeError):
                inputs.index_key(name)

    def prepare_fixture(self, *, checksum=None, source=None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        stage, existing = root/'run', root/'public-registry'
        (stage/'workspace').mkdir(parents=True)
        cache = existing/'index'/inputs.REGISTRY/'.cache'/inputs.index_key('example')
        cache.parent.mkdir(parents=True)
        cache.write_bytes(b'public-index')
        crate = b'public-crate-test-bytes'
        archive = existing/'cache'/inputs.REGISTRY/'example-1.0.0.crate'
        archive.parent.mkdir(parents=True)
        archive.write_bytes(crate)
        digest = checksum or hashlib.sha256(crate).hexdigest()
        registry = source or 'registry+https://github.com/rust-lang/crates.io-index'
        (stage/'workspace/Cargo.lock').write_text(
            'version = 4\n[[package]]\nname="example"\nversion="1.0.0"\n'
            f'source={json.dumps(registry)}\nchecksum="{digest}"\n')
        return stage, existing, cache, archive

    def test_reuses_only_public_metadata_and_verifies_crate_bytes(self):
        stage, existing, cache, archive = self.prepare_fixture()
        with patch.object(inputs, 'EXISTING', existing), \
             patch.object(inputs, 'downloaded', return_value=b'{}'), \
             patch.object(inputs.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', b'')):
            result = inputs.prepare(stage)
        self.assertTrue(result['allCrateChecksumsVerified'])
        self.assertEqual(result['packageCount'], 1)
        self.assertEqual(cache.read_bytes(), b'public-index')
        self.assertEqual(archive.read_bytes(), b'public-crate-test-bytes')
        copied = stage/'cargo/registry/index'/inputs.REGISTRY/'.cache'/inputs.index_key('example')
        self.assertEqual(copied.read_bytes(), cache.read_bytes())

    def test_rejects_corrupt_crate_before_build(self):
        stage, existing, _, _ = self.prepare_fixture(checksum='0'*64)
        with patch.object(inputs, 'EXISTING', existing), \
             patch.object(inputs, 'downloaded', return_value=b'{}'), \
             patch.object(inputs.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', b'')):
            with self.assertRaisesRegex(RuntimeError, 'checksum_mismatch'):
                inputs.prepare(stage)

    def test_rejects_unexpected_registry(self):
        stage, existing, _, _ = self.prepare_fixture(source='git+https://example.invalid/code')
        with patch.object(inputs, 'EXISTING', existing), \
             patch.object(inputs, 'downloaded', return_value=b'{}'), \
             patch.object(inputs.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', b'')):
            with self.assertRaisesRegex(RuntimeError, 'unexpected_cargo_source'):
                inputs.prepare(stage)


if __name__ == '__main__':
    unittest.main()
