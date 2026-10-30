import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from offline_common import InstallError
from package import export_images
from image_role import verify_application_role


class ImageArchiveReuseTests(unittest.TestCase):
    def test_legacy_image_requires_exact_application_entrypoint(self):
        verify_application_role('asr-plugin', {'Config': {'Labels': None,
            'Entrypoint': ['node', '/opt/teamaibox/apps/asr-plugin/src/server.mjs']}})
        with self.assertRaisesRegex(InstallError, 'matching entrypoint'):
            verify_application_role('wireless-casting-plugin', {'Config': {'Labels': None,
                'Entrypoint': ['node', '/opt/teamaibox/apps/virtual-phones-plugin/src/server.mjs']}})

    def test_rejects_correct_architecture_image_of_a_different_application(self):
        identifier = 'sha256:' + 'a' * 64
        def runner(*args, **kwargs):
            return json.dumps([dict(Id=identifier, Architecture='arm64', Os='linux', Size=15,
                Config=dict(Labels={'com.teamaibox.plugin.id': 'official.virtual-phones'}))])
        with tempfile.TemporaryDirectory() as temporary, self.assertRaisesRegex(InstallError, 'wrong role'):
            export_images([dict(role='wireless-casting-plugin', imageId=identifier, reference=identifier)], Path(temporary), runner)

    def test_verified_archive_reused_without_save(self):
        identifier = 'sha256:' + 'a' * 64
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache, output = root / 'cache', root / 'output'
            cache.mkdir(); output.mkdir()
            (cache / 'original.tar').write_bytes(b'archive fixture')
            rows = [dict(role=role, imageId=identifier, reference=identifier) for role in ('one', 'two')]
            commands = []
            def runner(args, **kwargs):
                commands.append(args)
                self.assertEqual(args[:3], ['docker', 'image', 'inspect'])
                return json.dumps([dict(Id=identifier, Architecture='arm64', Os='linux', Size=15)])
            with patch('package.verify_package', return_value=dict(images=[dict(imageId=identifier, archive='original.tar')])) as verify:
                export_images(rows, output, runner, cache)
                verify.assert_called_once_with(cache)
            self.assertEqual(len(commands), 2)
            self.assertEqual(rows[0]['archive'], rows[1]['archive'])
            self.assertEqual((output / rows[0]['archive']).read_bytes(), b'archive fixture')
            self.assertNotEqual((cache / 'original.tar').stat().st_ino, (output / rows[0]['archive']).stat().st_ino)

    def test_invalid_cache_fails_before_export(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch('package.verify_package', side_effect=InstallError('checksum mismatch')):
                with self.assertRaisesRegex(InstallError, 'checksum mismatch'):
                    export_images([], Path(temporary), image_cache=Path(temporary))


if __name__ == '__main__':
    unittest.main()
