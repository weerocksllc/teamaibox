"""Only public build input handling and recipe closure; no appliance actions."""
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from build_public_android import acquire
from build_public_services import RECIPES, NODE_SERVICES, ALIASES, UPSTREAM_IMAGES, public_image
from offline_common import IMAGE_ROLES, InstallError

ROOT = Path(__file__).resolve().parents[1]


class Download(io.BytesIO):
    def geturl(self):
        return 'https://example.org/archive'


class PublicBuildTests(unittest.TestCase):
    def test_cache_requires_exact_content(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'archive'
            raw = b'synthetic build archive'
            checksum = hashlib.sha256(raw).hexdigest()
            acquire('https://example.org/archive', checksum, path, lambda *a, **k: Download(raw))
            self.assertEqual(path.read_bytes(), raw)
            acquire('https://example.org/archive', checksum, path, lambda *a, **k: self.fail('cache fetched again'))
            path.write_bytes(b'changed')
            with self.assertRaises(InstallError):
                acquire('https://example.org/archive', checksum, path)
            self.assertEqual(path.read_bytes(), b'changed')

    def test_bad_download_is_not_admitted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'archive'
            with self.assertRaises(InstallError):
                acquire('https://example.org/archive', '0' * 64, path, lambda *a, **k: Download(b'<html>'))
            self.assertFalse(path.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_symlink_and_insecure_url_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'archive'
            target = Path(directory) / 'original'
            target.write_bytes(b'original')
            path.symlink_to(target)
            with self.assertRaises(InstallError):
                acquire('https://example.org/archive', '0' * 64, path)
            with self.assertRaises(InstallError):
                acquire('http://example.org/archive', '0' * 64, Path(directory) / 'other')
            self.assertEqual(target.read_bytes(), b'original')

    def test_external_images_have_public_digest_references(self):
        self.assertEqual(public_image('docker.io/example/runtime@sha256:' + 'a' * 64),
                         'docker.io/example/runtime@sha256:' + 'a' * 64)
        for value in [None, 'sha256:' + 'a' * 64, 'runtime:local', 'localhost/runtime@sha256:' + 'a' * 64,
                      '192.168.1.1/runtime@sha256:'+'a'*64]:
            with self.assertRaises(InstallError):
                public_image(value)

    def test_factory_roles_have_public_build_routes(self):
        separate = {'phone-runtime','phone-google-runtime','casting-sfu','desktop-proxy'}
        self.assertEqual(set(RECIPES) | set(ALIASES) | set(UPSTREAM_IMAGES) | separate, IMAGE_ROLES)
        self.assertTrue((ROOT/'services/drawing-worker/flux2_bf16_protected_server.py').is_file())
        for reference in UPSTREAM_IMAGES.values():
            public_image(reference)

    def test_recipes_and_node_entry_points_are_in_source(self):
        for recipe in RECIPES.values():
            self.assertTrue((ROOT / recipe).is_file(), recipe)
        for entry in NODE_SERVICES.values():
            self.assertTrue((ROOT / entry.removeprefix('/opt/teamaibox/')).is_file(), entry)
        for name in ['Dockerfile', 'Runtime.Dockerfile', 'Network.Dockerfile']:
            content = (ROOT / 'deploy/android/cuttlefish' / name).read_text()
            self.assertNotIn('FROM sha256:', content)
            self.assertNotIn('FROM teamaibox/', content)


if __name__ == '__main__':
    unittest.main()
