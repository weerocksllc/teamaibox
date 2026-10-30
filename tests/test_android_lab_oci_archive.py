import gzip
import hashlib
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'tools'))
from android_lab_oci_archive import convert


class ArchiveTests(unittest.TestCase):
    def fixture(self, root):
        blobs = root/'blobs/sha256'
        blobs.mkdir(parents=True)
        def save(data):
            value = hashlib.sha256(data).hexdigest()
            (blobs/value).write_bytes(data)
            return 'sha256:'+value
        payload = b'opaque-layer-not-extracted'
        layer = save(gzip.compress(payload))
        config = save(json.dumps({'architecture': 'arm64', 'rootfs': {
            'diff_ids': ['sha256:'+hashlib.sha256(payload).hexdigest()]}}).encode())
        manifest = save(json.dumps({'config': {'digest': config}, 'layers': [
            {'digest': layer, 'mediaType': 'application/vnd.oci.image.layer.v1.tar+gzip'}]}).encode())
        (root/'index.json').write_text(json.dumps({'manifests': [{'digest': manifest}]}))
        return blobs/layer[7:]

    def test_docker_archive_preserves_verified_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            target = root/'docker.tar'
            convert(root, target, 'teamaibox/android-lab-test:20260911-a1')
            with tarfile.open(target) as archive:
                manifest = json.load(archive.extractfile('manifest.json'))
                self.assertEqual(archive.extractfile(manifest[0]['Layers'][0]).read(),
                                 b'opaque-layer-not-extracted')
            with self.assertRaises(FileExistsError):
                convert(root, target, 'teamaibox/android-lab-test:20260911-a1')

    def test_rejects_changed_blob(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            layer = self.fixture(root)
            layer.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                convert(root, root/'docker.tar', 'teamaibox/android-lab-test:20260911-a1')


if __name__ == '__main__':
    unittest.main()
