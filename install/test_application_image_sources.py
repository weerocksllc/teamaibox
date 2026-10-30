import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from build_application_images import expected_files, files, desktop_asset_hashes, DESKTOP_ASSETS
from offline_common import InstallError


class ApplicationImageSourcesTests(unittest.TestCase):
    def test_console_dependency_and_licenses_are_verified_offline(self):
        with patch('build_application_images.run', return_value='\n'.join('a' * 64 + '  ' + p for p in DESKTOP_ASSETS)) as run:
            result = desktop_asset_hashes('sha256:' + 'b' * 64)
            self.assertEqual({Path(p).name for p in result}, {'all.min.js', 'LICENSE.txt', 'NOTICE.txt'})
            self.assertIn('none', run.call_args.args[0])
        with patch('build_application_images.run', return_value='a' * 64 + '  guacamole-common-js/all.min.js'):
            with self.assertRaises(InstallError):
                desktop_asset_hashes('sha256:' + 'b' * 64)

    def test_web_uses_only_current_canonical_bundle_and_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('apps/web/dist/index.html', 'apps/web/dist/assets/current.js', 'apps/web/server/web-boundary.mjs'):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(name)
            actual = expected_files(root, 'web')
            self.assertEqual(set(actual), {'/opt/teamaibox/web/index.html', '/opt/teamaibox/web/assets/current.js',
                                           '/opt/teamaibox/server/web-boundary.mjs'})

    def test_local_dependencies_and_settings_never_enter_source_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('app/server.mjs', 'app/.env', 'app/.env.private', 'app/__pycache__/x.pyc', 'app/node_modules/cache.js'):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('fixture')
            self.assertEqual(set(files(root, 'app', '/app')), {'/app/server.mjs'})
            (root / 'app/linked').symlink_to(root / 'app/server.mjs')
            with self.assertRaises(InstallError):
                files(root, 'app', '/app')


if __name__ == '__main__':
    unittest.main()
